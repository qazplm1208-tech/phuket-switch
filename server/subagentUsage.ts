import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MAX_SUBAGENT_CONTEXT_TOKENS, MIN_SUBAGENT_CONTEXT_TOKENS } from '../shared/constants.js';
import { subagentProtocols, type SubagentSessionUsage, type SubagentTokenUsage, type SubagentUsageByModel, type SubagentUsageResponse, type SubagentUsageTotals, type SubagentWorkerUsage } from '../shared/types.js';
import { cacheHitRatePct, getUserHome, isRecord, now, own } from './common.js';
import type { SwitchDb } from './db.js';
import { scrub, secrets } from './subagentRedaction.js';

const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const count = (v: unknown): number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0;
const oneOf = <T extends string>(v: unknown, allowed: readonly T[]) => allowed.find(item => item === v) ?? null;
function timestamp(seconds: unknown) {
  if (typeof seconds !== 'number' || seconds < 0) return null;
  const date = new Date(seconds * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function usage(input: unknown, cached: unknown, output: unknown, reasoning: unknown): SubagentTokenUsage {
  const inputTokens = count(input), cachedTokens = Math.min(count(cached), inputTokens), outputTokens = count(output);
  return { inputTokens, cachedTokens, outputTokens, reasoningTokens: count(reasoning), totalTokens: inputTokens + outputTokens, cacheHitRatePct: cacheHitRatePct(cachedTokens, inputTokens) };
}

// Trust the configured location, but not links/junctions in the Astra data tree.
async function dataRoot() {
  if (process.env.PLUGIN_DATA) {
    const root = path.resolve(process.env.PLUGIN_DATA);
    return path.join(await fs.realpath(path.dirname(root)), path.basename(root));
  }
  return path.join(await fs.realpath(getUserHome()), '.gemini', 'antigravity', 'plugin_data', 'gpt-astra-subagent');
}
async function readSnapshot(file: string) {
  const before = await fs.lstat(file);
  if (!before.isFile() || before.size > MAX_SNAPSHOT_BYTES || path.relative(file, await fs.realpath(file))) return;
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.ino !== before.ino || stat.dev !== before.dev || stat.size > MAX_SNAPSHOT_BYTES) return;
    // Bound the read itself as well as the stat: a concurrent writer can grow a file.
    const bytes = Buffer.allocUnsafe(stat.size);
    for (let i = 0; i < bytes.length;) {
      const { bytesRead } = await handle.read(bytes, i, bytes.length - i, i);
      if (!bytesRead) return;
      i += bytesRead;
    }
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (isRecord(value)) return value;
  } finally { await handle.close(); }
}
async function snapshots<T>(dir: string, idKey: 'session_id' | 'worker_id', project: (v: Record<string, unknown>) => T) {
  const rows: T[] = [];
  try {
    if (path.relative(dir, await fs.realpath(dir))) return rows;
    for await (const entry of await fs.opendir(dir)) {
      if (!entry.isFile() || !/^[A-Za-z0-9._-]+\.json$/.test(entry.name)) continue;
      try {
        const v = await readSnapshot(path.join(dir, entry.name));
        if (v && v[idKey] === entry.name.slice(0, -5)) rows.push(project(v));
      } catch { /* Corrupt, unreadable or concurrently replaced snapshot. */ }
    }
  } catch { /* Missing or inaccessible data directory is normal before first use. */ }
  return rows;
}

const emptyTotals = (): SubagentUsageTotals => ({ ...usage(0, 0, 0, 0), sessionCount: 0, turns: 0 });
function addSession(total: SubagentUsageTotals, session: SubagentSessionUsage) {
  total.sessionCount++; total.turns += session.turns;
  for (const key of ['inputTokens', 'cachedTokens', 'outputTokens', 'reasoningTokens', 'totalTokens'] as const) total[key] += session[key];
  total.cacheHitRatePct = cacheHitRatePct(total.cachedTokens, total.inputTokens);
}

export async function getSubagentUsage(db: SwitchDb): Promise<SubagentUsageResponse> {
  const totals = emptyTotals(), models = new Map<string, SubagentUsageByModel>();
  const root = await dataRoot().catch(() => null);
  if (!root) return { totals, byModel: [], sessions: [], workers: [], updatedAt: now() };
  const config = db.state('subagent'), keys = secrets(db, process.env.ASTRA_API_KEY);
  const text = (v: unknown) => typeof v === 'string' && v.length <= 32768 ? scrub(v, keys).replace(/[\x00-\x1f\x7f]/g, ' ') : '';
  const initialLimit = Math.max(MIN_SUBAGENT_CONTEXT_TOKENS, Math.min(MAX_SUBAGENT_CONTEXT_TOKENS, count(config.maxContextTokens)));
  const sessions = await snapshots<SubagentSessionUsage>(path.join(root, 'sessions'), 'session_id', s => {
    const limit = count(s.max_context_tokens);
    return {
      sessionId: text(s.session_id), cwd: text(s.cwd), mode: oneOf(s.mode, ['edit', 'readonly']), reasoningEffort: oneOf(s.reasoning_effort, ['none', 'low', 'medium', 'high', 'xhigh', 'max']),
      model: text(s.model) || 'unknown', protocol: oneOf(s.protocol, subagentProtocols), turns: count(s.turns), lastInputTokens: count(s.last_input_tokens),
      maxContextTokens: limit >= MIN_SUBAGENT_CONTEXT_TOKENS && limit <= MAX_SUBAGENT_CONTEXT_TOKENS ? limit : initialLimit,
      compactions: count(s.compactions), chunkCompactions: count(s.chunk_compactions), filesChangedCount: Array.isArray(s.files_changed) ? s.files_changed.length : 0, updatedAt: timestamp(s.updated_at),
      ...usage(s.total_input_tokens, s.total_cached_tokens, s.total_output_tokens, s.total_reasoning_tokens),
    };
  });
  const workers = await snapshots<SubagentWorkerUsage>(path.join(root, 'workers'), 'worker_id', w => {
    const u = w.usage ?? own(w.result).usage;
    return {
      workerId: text(w.worker_id), workerName: text(w.worker_name), sessionId: text(w.session_id), status: oneOf(w.status, ['running', 'completed', 'failed']) ?? 'unknown',
      model: text(w.model) || 'unknown', protocol: oneOf(w.api_format, subagentProtocols), stepsUsed: count(w.steps_used),
      elapsedSeconds: typeof w.elapsed_s === 'number' && Number.isFinite(w.elapsed_s) && w.elapsed_s >= 0 ? w.elapsed_s : null,
      startedAt: timestamp(w.started_at), finishedAt: timestamp(w.finished_at), usage: isRecord(u) ? usage(u.input_tokens, u.cached_tokens, u.output_tokens, u.reasoning_tokens) : null,
    };
  });
  for (const s of sessions) {
    const key = JSON.stringify([s.model, s.protocol]);
    const group = models.get(key) ?? { ...emptyTotals(), model: s.model, protocol: s.protocol };
    addSession(group, s); models.set(key, group); addSession(totals, s);
  }
  const byModel = [...models.values()].sort((a, b) => b.totalTokens - a.totalTokens || a.model.localeCompare(b.model) || (a.protocol ?? '').localeCompare(b.protocol ?? ''));
  sessions.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || a.sessionId.localeCompare(b.sessionId));
  workers.sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? '') || a.workerId.localeCompare(b.workerId));
  return { totals, byModel, sessions, workers, updatedAt: now() };
}
