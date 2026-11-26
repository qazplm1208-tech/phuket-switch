import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from 'node:sqlite';
import { DEFAULT_GPT_FAST_CONFIG, DEFAULT_PROXY_SETTINGS, PHUKET_BASE_URL, PHUKET_GPT_BASE_URL } from '../shared/constants.js';
import type { DirectBypassConfig, AppSettings, AppType, ConfigBackupItem, CreatePromptRequest, CreateProviderRequest, GptFastConfig, ImagePromptConfig, ModelRouteRule, PhuketAccount, PromptPreset, Provider, ProviderView, ProxyRequestLog, ProxySettings, ProxyTakeoverState, UpdatePromptRequest, UpdateProviderRequest } from '../shared/types.js';
import { directDownloadTargets, subagentHarnessIds, type DirectDownloadConfig, type SubagentConfig } from '../shared/types.js';
import { assertNotCcSwitch, conflict, getDataDir, missing, now } from './common.js';
export { getDataDir } from './common.js';

export function maskApiKey(key: string): string {
  if (!key) return '';
  return key.length > 14 ? `${key.slice(0, 7)}...${key.slice(-4)}` : '****';
}
export function toProviderView({ apiKey, ...provider }: Provider): ProviderView {
  return { ...provider, maskedKey: maskApiKey(apiKey) };
}
export const apps = ['claude', 'codex', 'gpt-native', 'claude-desktop', 'gemini', 'antigravity'] as const;
/** Private local state, not a management response DTO. Older sessions contain only token and account. */
export interface PhuketSession { token: string; refreshToken?: string; expiresAt?: number; account: PhuketAccount }
interface State {
  modelRoutes: ModelRouteRule[];
  fastMode: GptFastConfig;
  settings: AppSettings;
  directBypass: DirectBypassConfig;
  directDownload: DirectDownloadConfig;
  proxySettings: ProxySettings;
  proxyTakeover: ProxyTakeoverState;
  phuketSession: PhuketSession | null;
  proxyOriginalConfigs: Partial<Record<AppType, { providerId: string; backupId: string | null }>>;
  antigravityModelBindings: Record<string, string>;
  codexIncludeRoutedModels: boolean;
  codexCatalogRouteSlugs: string[];
  subagent: SubagentConfig & { apiKey: string };
  imagePrompt: ImagePromptConfig & { apiKey: string };
}
const defaults: State = {
  modelRoutes: [],
  fastMode: DEFAULT_GPT_FAST_CONFIG,
  settings: { theme: 'system', language: 'zh-CN', backupBeforeSwitch: true, autoCheckUpdates: true, defaultGptFastConfig: DEFAULT_GPT_FAST_CONFIG },
  directBypass: { enabled: false, mode: 'physical-nic', interfaceName: '', dnsServers: [], applyToSubagent: true },
  directDownload: { enabled: false, mode: 'physical-nic', interfaceName: '', dnsServers: [], connections: 4, retries: 5, maxRate: '', resume: true, enableTorrent: true,
    targets: Object.fromEntries(directDownloadTargets.map(id => [id, false])) as DirectDownloadConfig['targets'] },
  proxySettings: DEFAULT_PROXY_SETTINGS,
  proxyTakeover: { claude: false, codex: false, 'gpt-native': false, 'claude-desktop': false, gemini: false, antigravity: false },
  phuketSession: null, proxyOriginalConfigs: {}, antigravityModelBindings: {}, codexIncludeRoutedModels: false, codexCatalogRouteSlugs: [],
  subagent: { apiKey: '', keySource: 'manual', providerId: null, groupId: null, groupName: '', keyId: null, keyName: '', maskedKey: '',
    model: 'gpt-6.2-astra', protocol: 'openai-responses', baseUrl: PHUKET_GPT_BASE_URL, reasoningEffort: 'max', defaultMode: 'edit', maxContextTokens: 272000,
    enableChunkCompaction: true, compactTriggerPct: 88, compactKeepRecentGroups: 2,
    allowModelOverride: true, keyStorage: process.platform === 'win32' ? 'user-env' : 'mcp-env', writeRules: true,
    targets: Object.fromEntries(subagentHarnessIds.map(id => [id, false])) as SubagentConfig['targets'], updatedAt: null },
  imagePrompt: { enabled: false, groupId: 32, groupName: '生图-image', baseUrl: PHUKET_GPT_BASE_URL, defaultModel: 'gpt-image-2', models: [], keyId: null, keyName: '', apiKey: '', maskedKey: '', targets: { codex: true, claude: false }, updatedAt: null },
};
const columns = {
  id: 'TEXT PRIMARY KEY', appType: 'TEXT NOT NULL', name: 'TEXT NOT NULL', protocol: 'TEXT NOT NULL', baseUrl: 'TEXT NOT NULL', apiKey: 'TEXT NOT NULL', maskedKey: 'TEXT',
  phuketGroupId: 'INTEGER', phuketGroupName: 'TEXT', phuketPlatform: 'TEXT', rateMultiplier: 'REAL', model: 'TEXT', claudeModelMap: 'TEXT', codexFastConfig: 'TEXT', availableModels: 'TEXT',
  isCurrent: 'INTEGER NOT NULL', inFailoverQueue: 'INTEGER NOT NULL', priority: 'INTEGER NOT NULL', notes: 'TEXT', lastLatencyMs: 'INTEGER', lastTestedAt: 'TEXT', lastTestOk: 'INTEGER', createdAt: 'TEXT NOT NULL', updatedAt: 'TEXT NOT NULL',
} satisfies Record<keyof Provider, string>;
const jsonCols = new Set(['claudeModelMap', 'codexFastConfig', 'availableModels']);
const boolCols = new Set(['isCurrent', 'inFailoverQueue', 'lastTestOk']);
function encode(k: string, v: unknown): SQLInputValue {
  if (v == null) return null;
  return jsonCols.has(k) ? JSON.stringify(v) : boolCols.has(k) ? Number(v) : v as SQLInputValue;
}
function decode(row: Record<string, SQLOutputValue>): Provider {
  return Object.fromEntries(Object.entries(row).filter(([, v]) => v !== null).map(([k, v]) => [k, jsonCols.has(k) ? JSON.parse(String(v)) : boolCols.has(k) ? !!v : v])) as unknown as Provider;
}
const LEGACY_PHUKET_ORIGIN = 'https://ai.phuketcore.com';
function migratedPhuketBaseUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  const authority = /^https:\/\/[^/?#\\]+/i.exec(value)?.[0];
  if (!authority) return;
  const url = URL.parse(authority);
  if (url?.origin !== LEGACY_PHUKET_ORIGIN) return;
  url.host = new URL(PHUKET_BASE_URL).host;
  // The parsed authority ends in '/'. Keep the original suffix, including an empty one.
  return url.href.slice(0, -1) + value.slice(authority.length);
}
function migratePhuketBaseUrls(sql: DatabaseSync) {
  const setProvider = sql.prepare('UPDATE providers SET baseUrl=? WHERE id=?');
  for (const { id, baseUrl } of sql.prepare('SELECT id,baseUrl FROM providers').all()) {
    const migrated = migratedPhuketBaseUrl(baseUrl);
    if (migrated !== undefined) setProvider.run(migrated, id);
  }
  const setConfig = sql.prepare("UPDATE kv_state SET value=json_set(value,'$.baseUrl',?) WHERE key=?");
  const configs = sql.prepare(`SELECT key,json_extract(value,'$.baseUrl') AS baseUrl FROM kv_state
    WHERE key IN ('imagePrompt','subagent') AND json_valid(value)`);
  for (const { key, baseUrl } of configs.all()) {
    const migrated = migratedPhuketBaseUrl(baseUrl);
    if (migrated !== undefined) setConfig.run(migrated, key);
  }
}

export class SwitchDb {
  private readonly sql: DatabaseSync;
  constructor() {
    const dir = getDataDir(); mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, 'phuket-switch.db');
    for (const suffix of ['', '-wal', '-shm', '-journal']) assertNotCcSwitch(file + suffix);
    this.sql = new DatabaseSync(file);
    if (process.platform !== 'win32') chmodSync(file, 0o600);
    this.sql.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA trusted_schema=OFF;
      CREATE TABLE IF NOT EXISTS providers (${Object.entries(columns).map(([k, t]) => `${k} ${t}`).join(',')});
      CREATE UNIQUE INDEX IF NOT EXISTS one_current ON providers(appType) WHERE isCurrent=1;
      CREATE TABLE IF NOT EXISTS kv_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS proxy_logs (id TEXT NOT NULL UNIQUE, metadata TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS prompts (id TEXT PRIMARY KEY, name TEXT NOT NULL, appType TEXT NOT NULL, content TEXT NOT NULL, enabled INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS backups (id TEXT PRIMARY KEY, appType TEXT NOT NULL, createdAt TEXT NOT NULL, reason TEXT NOT NULL, files TEXT NOT NULL);
    `);
    this.transaction(() => {
      const insert = this.sql.prepare('INSERT OR IGNORE INTO kv_state(key,value) VALUES(?,?)');
      for (const [k, v] of Object.entries(defaults)) insert.run(k, JSON.stringify(v));
      migratePhuketBaseUrls(this.sql);
    });
  }
  close() { this.sql.close(); }
  transaction<T>(run: () => T): T {
    this.sql.exec('BEGIN IMMEDIATE');
    try { const value = run(); this.sql.exec('COMMIT'); return value; }
    catch (e) { this.sql.exec('ROLLBACK'); throw e; }
  }
  state<K extends keyof State>(key: K): State[K] {
    const stored = JSON.parse(String(this.sql.prepare('SELECT value FROM kv_state WHERE key=?').get(key)!.value));
    if (key === 'settings') return { ...defaults.settings, ...stored };
    if (key === 'subagent') return { ...defaults.subagent, ...stored, targets: { ...defaults.subagent.targets, ...stored.targets } };
    return key === 'proxyTakeover' ? { ...defaults.proxyTakeover, ...stored } : stored;
  }
  setState<K extends keyof State>(key: K, value: State[K]) { this.sql.prepare('UPDATE kv_state SET value=? WHERE key=?').run(JSON.stringify(value), key); }
  providers(app?: AppType): Provider[] {
    return this.sql.prepare(`SELECT * FROM providers ${app ? 'WHERE appType=?' : ''} ORDER BY priority, createdAt, rowid`).all(...(app ? [app] : [])).map(decode);
  }
  hasProvider(id: string, protocol: Provider['protocol']) {
    return !!this.sql.prepare('SELECT 1 FROM providers WHERE id=? AND protocol=?').get(id, protocol);
  }
  provider(id: string): Provider {
    const row = this.sql.prepare('SELECT * FROM providers WHERE id=?').get(id);
    if (!row) throw missing('Provider'); return decode(row);
  }
  current(app: AppType): Provider | null {
    const row = this.sql.prepare('SELECT * FROM providers WHERE appType=? AND isCurrent=1').get(app);
    return row ? decode(row) : null;
  }
  createProvider(req: Omit<CreateProviderRequest, 'phuketKeyId' | 'autoCreatePhuketKey'> & { apiKey: string }): Provider {
    const stamp = now();
    const p: Provider = { priority: 100, inFailoverQueue: false, ...req, maskedKey: maskApiKey(req.apiKey), isCurrent: false, id: randomUUID(), createdAt: stamp, updatedAt: stamp };
    const keys = Object.keys(columns) as (keyof Provider)[];
    this.sql.prepare(`INSERT INTO providers (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map(k => encode(k, p[k])));
    return this.provider(p.id);
  }
  updateProvider(id: string, patch: UpdateProviderRequest & Partial<Pick<Provider, 'lastLatencyMs' | 'lastTestedAt' | 'lastTestOk'>>): Provider {
    const groupReset = patch.phuketGroupId === null ? { phuketGroupName: null, phuketPlatform: null, rateMultiplier: null } : {};
    const fields = Object.entries({ ...patch, ...groupReset, ...(patch.apiKey !== undefined ? { maskedKey: maskApiKey(patch.apiKey) } : {}), updatedAt: now() }).filter(([k, v]) => Object.hasOwn(columns, k) && !['id', 'appType', 'isCurrent', 'createdAt'].includes(k) && v !== undefined);
    this.sql.prepare(`UPDATE providers SET ${fields.map(([k]) => `${k}=?`).join(',')} WHERE id=?`).run(...fields.map(([k, v]) => encode(k, v)), id);
    return this.provider(id);
  }
  setCurrentProvider(appType: AppType, id: string) {
    return this.transaction(() => {
      if (this.provider(id).appType !== appType) throw conflict('Provider belongs to another application.');
      const stamp = now();
      this.sql.prepare('UPDATE providers SET isCurrent=0,updatedAt=? WHERE appType=? AND isCurrent=1').run(stamp, appType);
      this.sql.prepare('UPDATE providers SET isCurrent=1,updatedAt=? WHERE id=?').run(stamp, id);
      return this.provider(id);
    });
  }
  deleteProvider(id: string) {
    this.transaction(() => {
      if (this.provider(id).isCurrent) throw conflict('Activate another provider before deleting the current provider.');
      this.sql.prepare('DELETE FROM providers WHERE id=?').run(id);
      this.setState('modelRoutes', this.state('modelRoutes').filter(r => r.targetProviderId !== id));
    });
  }
  addLog(log: ProxyRequestLog) {
    this.transaction(() => {
      this.sql.prepare('INSERT INTO proxy_logs(id,metadata) VALUES(?,?)').run(log.id, JSON.stringify(log));
      this.sql.exec('DELETE FROM proxy_logs WHERE rowid < (SELECT rowid FROM proxy_logs ORDER BY rowid DESC LIMIT 1 OFFSET 999)');
    });
  }
  logs(cursor?: string, limit = 100) {
    const rows = this.sql.prepare(`SELECT metadata FROM proxy_logs ${cursor ? 'WHERE rowid < (SELECT rowid FROM proxy_logs WHERE id=?)' : ''} ORDER BY rowid DESC LIMIT ?`).all(...(cursor ? [cursor, limit] : [limit]));
    return { items: rows.map(r => JSON.parse(String(r.metadata)) as ProxyRequestLog), total: Number(this.sql.prepare('SELECT count(*) n FROM proxy_logs').get()!.n) };
  }
  clearLogs() { this.sql.exec('DELETE FROM proxy_logs'); }
  addBackup(b: ConfigBackupItem) { this.sql.prepare('INSERT INTO backups VALUES(?,?,?,?,?)').run(b.id, b.appType, b.createdAt, b.reason, JSON.stringify(b.files)); }
  backups(id?: string): ConfigBackupItem[] {
    return this.sql.prepare(`SELECT * FROM backups ${id ? 'WHERE id=?' : ''} ORDER BY rowid DESC`).all(...(id ? [id] : [])).map(r => ({ ...r, files: JSON.parse(String(r.files)) }) as unknown as ConfigBackupItem);
  }
  prompts(id?: string): PromptPreset[] {
    return this.sql.prepare(`SELECT * FROM prompts ${id ? 'WHERE id=?' : ''} ORDER BY rowid`).all(...(id ? [id] : [])).map(r => ({ ...r, enabled: !!r.enabled }) as unknown as PromptPreset);
  }
  prompt(id: string) { const p = this.prompts(id)[0]; if (!p) throw missing('Prompt'); return p; }
  createPrompt(req: CreatePromptRequest) {
    const id = randomUUID(); this.sql.prepare('INSERT INTO prompts VALUES(?,?,?,?,0)').run(id, req.name, req.appType, req.content); return this.prompt(id);
  }
  updatePrompt(id: string, req: UpdatePromptRequest) {
    const p = this.prompt(id); this.sql.prepare('UPDATE prompts SET name=?,content=?,enabled=? WHERE id=?').run(req.name ?? p.name, req.content ?? p.content, req.content !== undefined && req.content !== p.content ? 0 : +p.enabled, id); return this.prompt(id);
  }
  enablePrompt(p: PromptPreset) { this.sql.prepare('UPDATE prompts SET enabled=(id=?) WHERE appType=?').run(p.id, p.appType); }
  deletePrompt(id: string) { if (!this.sql.prepare('DELETE FROM prompts WHERE id=?').run(id).changes) throw missing('Prompt'); }
}
