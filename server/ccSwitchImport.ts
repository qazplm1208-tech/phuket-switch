import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import type { AppType, CcSwitchDetectResult, CcSwitchImportResult, CreateProviderRequest } from '../shared/types.js';
import { getDataDir, getUserHome, httpBase, own, conflict } from './common.js';
import { protocolForApp } from '../shared/constants.js';
import { toProviderView, type SwitchDb } from './db.js';
import { parseJson } from './configFiles.js';
import { parseToml } from './surgicalToml.js';

const source = () => path.join(getUserHome(), '.cc-switch', 'cc-switch.db');
function onSource<T>(run: (sql: DatabaseSync) => T): T {
  const original = source(); let dir: string | undefined, sql: DatabaseSync | undefined;
  try {
    let dbPath = original;
    // Even a read-only SQLite connection can create -shm for a WAL database. Open a
    // coherent private copy in that case; never checkpoint or lock the source WAL.
    const header = Buffer.alloc(20), fd = fs.openSync(original, 'r');
    try { fs.readSync(fd, header, 0, header.length, 0); } finally { fs.closeSync(fd); }
    if (header[18] === 2 || fs.existsSync(original + '-wal')) {
      dir = fs.mkdtempSync(path.join(getDataDir(), 'cc-import-')); dbPath = path.join(dir, 'snapshot.db');
      const signature = () => ['', '-wal'].map(s => { const v = fs.statSync(original + s, { throwIfNoEntry: false, bigint: true }); return `${v?.ino}:${v?.size}:${v?.mtimeNs}`; }).join('|');
      const before = signature(); fs.copyFileSync(original, dbPath);
      if (fs.existsSync(original + '-wal')) fs.copyFileSync(original + '-wal', dbPath + '-wal');
      if (before !== signature()) throw conflict('CC-Switch changed during import. Retry when idle.');
    }
    sql = new DatabaseSync(dbPath, { readOnly: true }); sql.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;');
    return run(sql);
  } finally { sql?.close(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); }
}
function selection(sql: DatabaseSync, configs: boolean) {
  const schema = sql.prepare("SELECT sql FROM sqlite_schema WHERE name='providers' AND type='table'").get();
  if (!/^CREATE TABLE\s/i.test(String(schema?.sql))) throw conflict('Unsupported CC-Switch provider schema.');
  const cols = new Set(sql.prepare('PRAGMA table_info(providers)').all().map(r => String(r.name)));
  const type = ['app_type','appType'].find(c => cols.has(c));
  if (!type || !cols.has('id') || !cols.has('name')) throw conflict('Unsupported CC-Switch provider schema.');
  const extra = configs ? ['settings_config','settingsConfig','config','base_url','baseUrl','api_key','apiKey','model'].filter(k => cols.has(k)).map(k => `,${k}`).join('') : '';
  const raw = sql.prepare(`SELECT id,name,${type} AS app${extra} FROM providers WHERE ${type} IN ('claude','codex','grokbuild','claude-desktop','gpt-native','gemini') ORDER BY ${type},name,id`).all();
  const counts = new Map<string, number>(); for (const r of raw) counts.set(String(r.id), (counts.get(String(r.id)) ?? 0) + 1);
  return raw.map(r => ({ raw: r, sourceId: counts.get(String(r.id)) === 1 ? String(r.id) : `${r.app}:${r.id}`, name: String(r.name), appType: (r.app === 'grokbuild' ? 'gpt-native' : r.app) as AppType }));
}
export function detectCcSwitch(): CcSwitchDetectResult {
  if (!fs.existsSync(source())) return { detected: false, sourcePath: null, providers: [], warnings: [] };
  try { return { detected: true, sourcePath: source(), providers: onSource(sql => selection(sql, false).map(({ raw: _, ...item }) => item)), warnings: [] }; }
  catch { return { detected: true, sourcePath: source(), providers: [], warnings: ['Cannot read this CC-Switch provider database.'] }; }
}
function convert(item: ReturnType<typeof selection>[number]): CreateProviderRequest & { apiKey: string } {
  const { appType, name, raw } = item, anthropic = appType === 'claude' || appType === 'claude-desktop';
  const s = parseJson(String(raw.settings_config ?? raw.settingsConfig ?? raw.config ?? '{}'));
  if (appType === 'gemini') {
    const env = typeof s.env === 'string' ? parseEnv(s.env) : own(s.env);
    const apiKey = env.GEMINI_API_KEY ?? s.GEMINI_API_KEY ?? s.apiKey ?? raw.api_key ?? raw.apiKey;
    const baseUrl = env.GOOGLE_GEMINI_BASE_URL ?? s.GOOGLE_GEMINI_BASE_URL ?? s.baseUrl ?? raw.base_url ?? raw.baseUrl;
    const model = env.GEMINI_MODEL ?? s.GEMINI_MODEL ?? s.model ?? raw.model;
    if (typeof apiKey !== 'string' || !apiKey || /[\r\n\0]/.test(apiKey) || typeof baseUrl !== 'string' || !httpBase(baseUrl) || !name.trim()) throw conflict('Missing usable Gemini endpoint or credential.');
    return { name, appType, protocol: 'gemini-native', baseUrl, apiKey, ...(typeof model === 'string' && model ? { model } : {}) };
  }
  const parsedAuth = typeof s.auth === 'string' ? parseJson(s.auth) : own(s.auth);
  const env = own(s.env), auth = parsedAuth, config = typeof s.config === 'string' ? parseToml(s.config) : own(s.config);
  const group = own(config.model_providers), pc = own(group[String(config.model_provider || 'custom')] ?? Object.values(group)[0]);
  const apiKey = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || auth.OPENAI_API_KEY || pc.experimental_bearer_token || s.apiKey || s.api_key || env.XAI_API_KEY || env.OPENAI_API_KEY || raw.api_key || raw.apiKey;
  const baseUrl = env.ANTHROPIC_BASE_URL || pc.base_url || s.baseURL || s.baseUrl || s.base_url || env.OPENAI_BASE_URL || env.XAI_BASE_URL || raw.base_url || raw.baseUrl;
  const model = env.ANTHROPIC_MODEL || config.model || s.model || raw.model;
  if (typeof apiKey !== 'string' || !apiKey || /[\r\n]/.test(apiKey) || typeof baseUrl !== 'string' || !httpBase(baseUrl) || !name.trim()) throw conflict('Missing usable endpoint or credential.');
  return { name, appType, protocol: protocolForApp(appType), baseUrl, apiKey, ...(typeof model === 'string' && model ? { model } : {}), ...(anthropic ? { claudeModelMap: { opus: env.ANTHROPIC_DEFAULT_OPUS_MODEL, sonnet: env.ANTHROPIC_DEFAULT_SONNET_MODEL, haiku: env.ANTHROPIC_DEFAULT_HAIKU_MODEL, defaultModel: env.ANTHROPIC_MODEL } } : {}) };
}
export function importCcSwitch(db: SwitchDb, ids?: string[]): CcSwitchImportResult {
  const result: CcSwitchImportResult = { imported: [], skipped: [], warnings: [] };
  if (!fs.existsSync(source())) return { ...result, warnings: ['CC-Switch was not detected.'] };
  const items = onSource(sql => selection(sql, true));
  const wanted = ids ? new Set(ids) : null, existing = db.providers();
  db.transaction(() => {
    for (const item of items) {
      if (wanted && !wanted.delete(item.sourceId)) continue;
      let request: ReturnType<typeof convert>;
      try { request = convert(item); } catch { result.skipped.push({ sourceId: item.sourceId, reason: 'Unsupported or incomplete provider settings.' }); continue; }
      if (existing.some(p => p.appType === request.appType && p.name === request.name && p.baseUrl === request.baseUrl && p.apiKey === request.apiKey)) { result.skipped.push({ sourceId: item.sourceId, reason: 'Already imported.' }); continue; }
      const p = db.createProvider(request); existing.push(p); result.imported.push(toProviderView(p));
    }
    for (const id of wanted ?? []) result.skipped.push({ sourceId: id, reason: 'Not found.' });
  });
  return result;
}
