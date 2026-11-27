import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { allowedGroupModels, canCreateGroupKey, defaultBaseUrlForApp, MAX_SUBAGENT_CONTEXT_TOKENS, MIN_SUBAGENT_CONTEXT_TOKENS, PHUKET_BASE_URL, pickRecommendedModel } from '../shared/constants.js';
import { type ApplySubagentRequest, type ApplySubagentResult, type RemoveSubagentRequest, type SubagentDiffPreview, type SubagentStatus, type SubagentTestRequest, type SubagentTestResult } from '../shared/types.js';
import { parseSubagentBase, subagentApiRoot } from '../shared/subagentEndpoint.js';
import { ApiError, bad, conflict, elapsed, isRecord, now, secretField } from './common.js';
import { commitFiles, jsonText, managedText, parseJson, subagentPaths, type Plan } from './configFiles.js';
import { maskApiKey, type SwitchDb } from './db.js';
import type { PhuketClient } from './phuketClient.js';
import { hasAstraUserEnvKey, readAstraUserEnvKey } from './subagentEnvironment.js';
import { checkUserKeyDestinations, harnessStates, installPlan, uninstallPlan, useUserEnv, type StoredConfig } from './subagentHarnesses.js';
import { bundledScript, detectPython, handshake } from './subagentPython.js';
import { redactToml } from './surgicalToml.js';
import { adaptiveFetch, readBodyBytes } from './upstreamTransport.js';
import { scrub, secrets } from './subagentRedaction.js';

const mask = '[REDACTED]';
function publicStrings<T>(value: T, keys: string[]): T {
  if (typeof value === 'string') return scrub(value, keys) as T;
  if (Array.isArray(value)) return value.map(v => publicStrings(v, keys)) as T;
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, publicStrings(v, keys)])) as T;
  return value;
}
function safeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safeJson);
  if (!isRecord(value)) return value;
  const publicField = (k: string, v: unknown) => ['ASTRA_KEY_STORAGE', 'keywords'].includes(k) || (['ASTRA_MAX_CONTEXT_TOKENS', 'ASTRA_COMPACT_TRIGGER_TOKENS'].includes(k) && typeof v === 'string' && /^\d{1,7}$/.test(v));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, (secretField(k) && !publicField(k, v)) || /headers/i.test(k) ? mask : safeJson(v)]));
}
function safeFile(file: string, text: string | null, keys: string[]) {
  if (text === null) return null;
  if (file.endsWith('.py')) return `# Python script; ${Buffer.byteLength(text)} bytes; SHA-256 ${createHash('sha256').update(text).digest('hex')}`;
  const sanitized = file.endsWith('.toml') ? redactToml(text) : file.endsWith('.json') ? jsonText(publicStrings(safeJson(parseJson(text)), keys)) : text;
  return scrub(sanitized, keys);
}
export function getSubagentStatus(db: SwitchDb): SubagentStatus {
  const c = db.state('subagent'), { apiKey, ...config } = c, python = detectPython(config.pythonPath);
  const userKey = readAstraUserEnvKey(), keys = secrets(db, userKey ?? '');
  const status = publicStrings({ config, python, userEnvHasKey: !!userKey, runtimeScriptPath: subagentPaths().runtime, harnesses: harnessStates(c, python.executable ?? 'python', db.state('directBypass'), db.state('directDownload')), updatedAt: now() }, keys);
  status.config.maskedKey = maskApiKey(apiKey);
  return status;
}
function sameOrigin(base: string, credentialBase: string) {
  const origin = parseSubagentBase(base)?.origin;
  if (!origin || origin !== parseSubagentBase(credentialBase)?.origin) throw bad('Supply a new manual key when changing the provider origin.');
}
const resetSource = { keyId: null, keyName: '', providerId: null, groupId: null, groupName: '' };
async function groupCredential(db: SwitchDb, phuket: PhuketClient, req: ApplySubagentRequest, c: StoredConfig, preview: boolean) {
  const s = db.state('phuketSession'); if (!s) throw new ApiError(401, 'LOGIN_REQUIRED', 'Sign in to select a Phuket group key.');
  const keyById = async (id: number) => {
    const k = await phuket.getRawKeyById(s.token, id);
    if (k.item.status !== 'active' || (req.groupId !== undefined && req.groupId !== k.item.group_id)) throw bad('The key is not active in the selected group.');
    return k;
  };
  let found = req.phuketKeyId !== undefined ? await keyById(req.phuketKeyId) : null;
  const id = req.groupId ?? found?.item.group_id;
  const group = (await phuket.getMergedGroups(s.token)).find(g => g.id === id);
  if (!group?.protocol || !group.supportedAppTypes.length) throw bad('Choose an inference group.');
  c.protocol = req.protocol ?? group.protocol;
  c.model = req.model ?? pickRecommendedModel(allowedGroupModels(group), group.protocol) ?? c.model;
  c.baseUrl = req.baseUrl ?? defaultBaseUrlForApp(group.supportedAppTypes[0], group);
  sameOrigin(c.baseUrl, PHUKET_BASE_URL);
  if (!found && !preview && !req.autoCreatePhuketKey) {
    for (let page = 1; page <= 10000; page++) {
      const batch = await phuket.listKeys(s.token, page, 100);
      for (const k of batch.items.filter(k => k.status === 'active' && k.group_id === id)) {
        try { found = await keyById(k.id); break; }
        catch (e) { if (!(e instanceof ApiError) || ![404, 409].includes(e.status)) throw e; }
      }
      if (found || batch.items.length < 100 || page * 100 >= batch.total) break;
    }
  }
  if (!found && !preview) {
    if (!canCreateGroupKey(group, s.account.allowed_groups)) throw bad('The account cannot create a key for this group.');
    found = await phuket.createKey(s.token, { name: 'phuket-switch-subagent', group_id: group.id });
  }
  Object.assign(c, resetSource, { groupId: group.id, groupName: group.name, keyId: found?.item.id ?? null, keyName: found?.item.name ?? '', keySource: 'phuket-group', apiKey: found?.key ?? mask });
}
async function resolveConfig(db: SwitchDb, phuket: PhuketClient, req: ApplySubagentRequest, preview: boolean) {
  const old = db.state('subagent');
  const { targets, providerId, groupId, apiKey, phuketKeyId, autoCreatePhuketKey, keepExistingKey, ...options } = req;
  const c: StoredConfig = { ...old, ...options, targets: { ...old.targets } };
  if (req.pythonPath === '') delete c.pythonPath; // Explicitly reset a saved interpreter to automatic detection.
  if (providerId) {
    const p = db.provider(providerId);
    Object.assign(c, resetSource, { providerId, keySource: 'provider', keyName: p.name, apiKey: p.apiKey, groupId: p.phuketGroupId ?? null, groupName: p.phuketGroupName ?? '',
      baseUrl: req.baseUrl ?? p.baseUrl, model: req.model ?? p.model ?? c.model, protocol: req.protocol ?? p.protocol });
    sameOrigin(c.baseUrl, p.baseUrl);
  } else if (apiKey) Object.assign(c, resetSource, { keySource: 'manual', apiKey });
  else if (phuketKeyId || groupId || autoCreatePhuketKey) await groupCredential(db, phuket, req, c, preview);
  else if (keepExistingKey !== false && old.apiKey) sameOrigin(c.baseUrl, old.baseUrl);
  else if (c.keyStorage === 'user-env' && hasAstraUserEnvKey()) {
    sameOrigin(c.baseUrl, old.baseUrl);
    Object.assign(c, resetSource, { keySource: 'user-env', apiKey: useUserEnv(c) ? '' : readAstraUserEnvKey()! });
  } else if (preview) c.apiKey = mask;
  else throw bad('Choose a provider or supply an API key.');
  // Old saved configurations could exceed the Python runtime's hard context bounds.
  c.maxContextTokens = Math.max(MIN_SUBAGENT_CONTEXT_TOKENS, Math.min(MAX_SUBAGENT_CONTEXT_TOKENS, c.maxContextTokens));
  if (!parseSubagentBase(c.baseUrl) || (c.apiKey && !/^[\x21-\x7e]{1,16384}$/.test(c.apiKey))) throw bad('Invalid subagent connection settings.');
  c.maskedKey = maskApiKey(c.apiKey); for (const id of targets) c.targets[id] = true;
  return c;
}
function planFor(db: SwitchDb, req: ApplySubagentRequest, c: StoredConfig, preview: boolean) {
  const python = detectPython(c.pythonPath);
  if (!preview && !python.meetsMinimum) throw bad(python.error!);
  const plan = installPlan(req.targets, c, python.executable ?? 'python', fs.readFileSync(bundledScript(), 'utf8'), db.state('directBypass'), db.state('directDownload'));
  if (useUserEnv(c)) checkUserKeyDestinations(c.baseUrl, plan, !!c.apiKey);
  return plan;
}
export async function previewSubagent(db: SwitchDb, phuket: PhuketClient, req: ApplySubagentRequest): Promise<SubagentDiffPreview> {
  const c = await resolveConfig(db, phuket, req, true), plan = planFor(db, req, c, true), keys = secrets(db, c.apiKey);
  const warnings = useUserEnv(c) ? ['ASTRA_API_KEY is not written to MCP files. Restart the harness after changing Windows user environment variables.'] : ['Selected MCP configurations will contain an API key.'];
  if (!detectPython(c.pythonPath).meetsMinimum) warnings.push('Python 3.10 or later is required to apply.');
  return { files: [...plan].map(([file, after]) => ({ path: file, before: safeFile(file, managedText(file), keys), after: safeFile(file, after?.toString() ?? null, keys) })), warnings };
}
function commit(db: SwitchDb, c: StoredConfig, plan: Plan, reason: string, writeKey = false): ApplySubagentResult {
  const old = db.state('subagent');
  if (JSON.stringify(c) !== JSON.stringify(old) || [...plan].some(([file, after]) => managedText(file) !== after)) c.updatedAt = now();
  plan.subagent = { config: c, ...(writeKey && useUserEnv(c) && c.apiKey ? { userKey: c.apiKey } : {}) };
  const system = commitFiles(db, 'codex', reason, plan);
  return { system, status: getSubagentStatus(db) };
}
export async function applySubagent(db: SwitchDb, phuket: PhuketClient, req: ApplySubagentRequest): Promise<ApplySubagentResult> {
  // Validate files and interpreter before a potentially irreversible remote key creation.
  if ((req.groupId || req.autoCreatePhuketKey) && !req.phuketKeyId && !req.apiKey && !req.providerId) {
    const preflight = planFor(db, req, { ...db.state('subagent'), pythonPath: req.pythonPath ?? db.state('subagent').pythonPath }, false);
    for (const file of preflight.keys()) managedText(file);
  }
  const c = await resolveConfig(db, phuket, req, false);
  return commit(db, c, planFor(db, req, c, false), 'Apply subagent', true);
}
export function removeSubagent(db: SwitchDb, req: RemoveSubagentRequest): ApplySubagentResult {
  const c = db.state('subagent'), plan = uninstallPlan(req.targets, req.removeRules !== false, c);
  for (const id of req.targets) c.targets[id] = false;
  return commit(db, c, plan, 'Remove subagent');
}
export async function testSubagent(db: SwitchDb, req: SubagentTestRequest, send: typeof fetch = fetch): Promise<SubagentTestResult> {
  const start = performance.now(), c = db.state('subagent'), p = req.providerId ? db.provider(req.providerId) : null;
  const model = req.model ?? p?.model ?? c.model, protocol = req.protocol ?? p?.protocol ?? c.protocol;
  const python = detectPython(req.pythonPath ?? c.pythonPath), base = req.baseUrl ?? p?.baseUrl ?? c.baseUrl;
  const parsedBase = parseSubagentBase(base);
  if (!parsedBase) throw bad('Invalid subagent API base URL.');
  const result: SubagentTestResult = { ok: false, latencyMs: 0, pythonExecutable: python.executable, pythonVersion: python.version, serverVersion: null, toolsCount: 0, tools: [], effectiveModel: model, effectiveProtocol: protocol, testedAt: now() };
  if (!python.meetsMinimum || !python.executable) result.error = python.error;
  else try {
    const handshakeStart = performance.now();
    const { tools, version } = await handshake(python.executable, model, protocol);
    Object.assign(result, { tools, toolsCount: tools.length, serverVersion: version, handshakeLatencyMs: elapsed(handshakeStart), ok: true });
  } catch { result.error = 'The bundled Python server did not complete its MCP handshake.'; }
  if (req.testUpstream) {
    const key = req.apiKey ?? p?.apiKey ?? (c.apiKey || (c.keyStorage === 'user-env' ? readAstraUserEnvKey() : null));
    result.upstreamOk = null;
    if (key) {
      if (!req.apiKey) sameOrigin(base, p?.baseUrl ?? c.baseUrl);
      const modelsUrl = subagentApiRoot(parsedBase, protocol) + '/models';
      const headers = new Headers(protocol === 'gemini-native' ? { 'x-goog-api-key': key } : protocol === 'anthropic-messages' ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } : { authorization: `Bearer ${key}` });
      try {
        const response = await adaptiveFetch(modelsUrl, { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(10000) }, send);
        if (!response.ok) { await response.body?.cancel(); result.upstreamError = `Models request returned HTTP ${response.status}.`; result.upstreamOk = false; }
        else {
          const data = JSON.parse((await readBodyBytes(response, 1024 * 1024)).toString());
          result.upstreamOk = Array.isArray(data?.data ?? data?.models ?? data);
          if (!result.upstreamOk) result.upstreamError = 'The server did not return a model list.';
        }
      } catch { result.upstreamOk = false; result.upstreamError = 'The models endpoint could not be verified.'; }
      result.ok &&= result.upstreamOk;
    }
  }
  result.latencyMs = elapsed(start); return publicStrings(result, secrets(db, req.apiKey ?? ''));
}
