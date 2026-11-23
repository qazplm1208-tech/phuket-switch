import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppType, SubagentConfig, SystemApplyResult } from '../shared/types.js';
import { readAstraUserEnvKey, writeAstraUserEnvKey } from './subagentEnvironment.js';
import { agyEnvNote, readAgyEnv, validAgyEnv, writeAgyEnv, type AgyEnv } from './agyEnvironment.js';
import type { SwitchDb } from './db.js';
import { assertNotCcSwitch, conflict, getDataDir, getUserHome, isRecord, missing, now, notApplied } from './common.js';

export const CLAUDE_DESKTOP_PROFILE_ID = '00000000-0000-4000-8000-000000157220';
export const CLAUDE_DESKTOP_PROFILE_NAME = 'Phuket Switch';
export function claudeDesktopConfigDir() {
  const home = getUserHome(), local = path.join(home, 'AppData', 'Local');
  const root = process.platform === 'win32' ? (process.env.PHUKET_SWITCH_USER_HOME ? local : process.env.LOCALAPPDATA || local)
    : process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support') : path.join(home, '.config');
  return path.join(root, 'Claude-3p', 'configLibrary');
}
export function cliPaths() {
  const home = getUserHome(), claude = path.join(home, '.claude'), codex = path.join(home, '.codex'), desktop = claudeDesktopConfigDir();
  return { geminiEnv: path.join(home, '.gemini', '.env'), geminiSettings: path.join(home, '.gemini', 'settings.json'), antigravitySettings: path.join(home, '.gemini', 'antigravity-cli', 'settings.json'),
    claudeDesktopMeta: path.join(desktop, '_meta.json'), claudeDesktopProfile: path.join(desktop, `${CLAUDE_DESKTOP_PROFILE_ID}.json`),
    claude: path.join(claude, 'settings.json'), codex: path.join(codex, 'config.toml'), auth: path.join(codex, 'auth.json'), catalog: path.join(codex, 'phuket-switch-model-catalog.json'), claudeMcp: path.join(home, '.claude.json'), claudePrompt: path.join(claude, 'CLAUDE.md'), codexPrompt: path.join(codex, 'AGENTS.md') };
}
export function subagentPaths() {
  const home = getUserHome(), cli = cliPaths(), at = (...p: string[]) => path.join(home, ...p);
  const isolated = process.env.PHUKET_SWITCH_USER_HOME !== undefined;
  const roaming = process.platform === 'win32' ? (!isolated && process.env.APPDATA || at('AppData', 'Roaming'))
    : process.platform === 'darwin' ? at('Library', 'Application Support') : at('.config');
  const plugin = (...p: string[]) => at('.gemini', 'config', 'plugins', 'gpt-astra-subagent', ...p);
  return {
    runtime: at('.phuket-switch', 'subagent', 'server', 'astra_mcp_server.py'),
    pluginManifest: plugin('plugin.json'), pluginMcp: plugin('mcp_config.json'), pluginRules: plugin('rules', 'AGENTS.md'),
    pluginSkill: plugin('skills', 'gpt-astra-orchestrator', 'SKILL.md'), pluginServer: plugin('server', 'astra_mcp_server.py'),
    claudeMcp: cli.claudeMcp, claudeRules: cli.claudePrompt, codexMcp: cli.codex, codexRules: cli.codexPrompt,
    geminiMcp: cli.geminiSettings, geminiRules: at('.gemini', 'GEMINI.md'),
    desktopMcp: path.join(roaming, 'Claude', 'claude_desktop_config.json'), desktop3pMcp: path.join(path.dirname(claudeDesktopConfigDir()), 'claude_desktop_config.json'),
    cursorMcp: at('.cursor', 'mcp.json'), windsurfMcp: at('.codeium', 'windsurf', 'mcp_config.json'), windsurfRules: at('.codeium', 'windsurf', 'memories', 'global_rules.md'),
    opencodeMcp: at('.config', 'opencode', 'opencode.json'), opencodeRules: at('.config', 'opencode', 'AGENTS.md'),
    clineVsMcp: path.join(roaming, 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'),
    clineMcp: at('.cline', 'data', 'settings', 'cline_mcp_settings.json'), clineRules: at('.cline', 'rules', 'phuket-subagent.md'),
  };
}
function checkUnlinkedPath(file: string) {
  assertNotCcSwitch(file);
  const home = getUserHome();
  // LOCALAPPDATA need not be under the home directory. path.relative handles Windows path casing.
  for (let p = path.resolve(file); ; p = path.dirname(p)) {
    if (fs.lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink()) throw conflict('Refusing to follow a symlinked CLI configuration.');
    if (path.relative(home, p) === '' || path.dirname(p) === p) break;
  }
}
function checkTarget(file: string) {
  if (!Object.values(cliPaths()).includes(file) && !Object.values(subagentPaths()).includes(file)) throw conflict('Path is not a managed CLI configuration.');
  checkUnlinkedPath(file);
}
export function managedText(file: string) { checkTarget(file); return textFile(file); }
export function desktopConfigText(file: string) {
  if (path.dirname(file) !== claudeDesktopConfigDir()) throw conflict('Invalid Claude Desktop profile path.');
  checkUnlinkedPath(file);
  return textFile(file);
}
function bytes(file: string): Buffer | null {
  try { return fs.readFileSync(file); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
}
export const textFile = (file: string) => bytes(file)?.toString('utf8') ?? null;
export const jsonText = (obj: unknown) => JSON.stringify(obj, null, 2) + '\n';
export function parseJson(text: string | null): Record<string, any> {
  if (text === null) return {};
  try { const data: unknown = JSON.parse(text.replace(/^\uFEFF/, '')); if (isRecord(data)) return data; } catch { /* no parser excerpts in errors */ }
  throw conflict('Invalid JSON configuration; no changes were made.');
}
function atomicWrite(file: string, content: Buffer | null) {
  checkTarget(file);
  if (content === null) { fs.rmSync(file, { force: true }); return; }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.phuket-tmp-${randomUUID()}`;
  try { fs.writeFileSync(tmp, content, { flag: 'wx', mode: 0o600, flush: true }); fs.renameSync(tmp, file); }
  finally { fs.rmSync(tmp, { force: true }); }
}
type AgySnapshot = { bindings: Record<string, string>; env?: AgyEnv };
type SubagentSnapshot = { config: SubagentConfig & { apiKey: string }; userKey?: string | null };
export type Plan = Map<string, string | Buffer | null> & { antigravity?: AgySnapshot; subagent?: SubagentSnapshot };
type Original = { file: string; content: Buffer | null };
function snapshot(db: SwitchDb, appType: AppType, reason: string, originals: Original[], agy?: AgySnapshot, subagent?: SubagentSnapshot) {
  const createdAt = now(), id = createdAt.replace(/[:.]/g, '-') + '-' + randomUUID();
  const dir = path.join(getDataDir(), 'backups', id); assertNotCcSwitch(dir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    const manifest = originals.map(({ file, content }, i) => {
      if (content !== null) fs.writeFileSync(path.join(dir, `${i}.original`), content, { mode: 0o600, flag: 'wx', flush: true });
      return { path: file, existed: content !== null };
    });
    if (subagent) fs.writeFileSync(path.join(dir, 'subagent.json'), jsonText(subagent), { mode: 0o600, flag: 'wx', flush: true });
    if (agy) fs.writeFileSync(path.join(dir, 'antigravity.json'), jsonText(agy), { mode: 0o600, flag: 'wx', flush: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), jsonText(manifest), { mode: 0o600, flag: 'wx', flush: true });
    db.addBackup({ id, appType, createdAt, reason, files: originals.map(f => f.file) });
  } catch (e) { fs.rmSync(dir, { recursive: true, force: true }); throw e; }
  return id;
}
export function commitFiles(db: SwitchDb, app: AppType, reason: string, plan: Plan, forceSnapshot = false): SystemApplyResult {
  const agy = app === 'antigravity' ? plan.antigravity : undefined;
  const previous = agy ? { bindings: db.state('antigravityModelBindings'), env: readAgyEnv() } : undefined;
  const envChanged = !!(previous?.env && agy?.env && (previous.env.GEMINI_API_KEY !== agy.env.GEMINI_API_KEY || previous.env.GOOGLE_GEMINI_BASE_URL !== agy.env.GOOGLE_GEMINI_BASE_URL));
  const note = agy ? { warnings: [agyEnvNote()] } : {};
  const originals: Original[] = [], changes: Original[] = [];
  for (const [file, value] of plan) {
    checkTarget(file);
    const content = bytes(file), next = typeof value === 'string' ? Buffer.from(value) : value;
    const changed = next === null ? content !== null : !content?.equals(next);
    if (changed || forceSnapshot || envChanged) originals.push({ file, content });
    if (changed) changes.push({ file, content: next });
  }
  const sub = plan.subagent;
  const previousSub = sub ? { config: db.state('subagent'), ...(sub.userKey !== undefined ? { userKey: readAstraUserEnvKey() } : {}) } : undefined;
  const keyChanged = sub?.userKey !== undefined && previousSub?.userKey !== sub.userKey;
  const stateChanged = sub && JSON.stringify(previousSub?.config) !== JSON.stringify(sub.config);
  if (!originals.length && !keyChanged && !stateChanged) return { ...notApplied(), ...note };
  const backupId = snapshot(db, app, reason, originals, previous, previousSub), written = new Set<string>();
  let writingEnv = false;
  try {
    for (const f of changes) { atomicWrite(f.file, f.content); written.add(f.file); }
    if (envChanged && agy?.env) { writingEnv = true; writeAgyEnv(agy.env); }
    if (keyChanged) { writingEnv = true; writeAstraUserEnvKey(sub!.userKey!); }
    if (sub) db.setState('subagent', sub.config);
    if (agy) db.setState('antigravityModelBindings', agy.bindings);
  } catch (e) {
    for (const f of originals.reverse()) if (written.has(f.file)) atomicWrite(f.file, f.content);
    if (writingEnv && previousSub?.userKey !== undefined) writeAstraUserEnvKey(previousSub.userKey);
    if (writingEnv && previous?.env) writeAgyEnv(previous.env);
    throw e;
  }
  return { applied: true, backupId, changedPaths: changes.map(c => c.file), ...note };
}
export function restoreBackup(db: SwitchDb, id: string) {
  const entry = db.backups(id)[0]; if (!entry) throw missing('Backup');
  if (!/^[\w-]+$/.test(entry.id)) throw conflict('Invalid backup ID.');
  const dir = path.join(getDataDir(), 'backups', entry.id);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as unknown;
  if (!Array.isArray(manifest) || manifest.length !== entry.files.length) throw conflict('Incomplete backup manifest.');
  const plan: Plan = new Map();
  for (const [i, m] of manifest.entries()) {
    if (!isRecord(m) || m.path !== entry.files[i] || typeof m.existed !== 'boolean') throw conflict('Invalid backup manifest.');
    checkTarget(m.path); plan.set(m.path, m.existed ? fs.readFileSync(path.join(dir, `${i}.original`)) : null);
  }
  if (entry.appType === 'antigravity') {
    const extra = parseJson(textFile(path.join(dir, 'antigravity.json')));
    if (!isRecord(extra.bindings) || !Object.values(extra.bindings).every(v => typeof v === 'string') || (extra.env !== undefined && !validAgyEnv(extra.env))) throw conflict('Incomplete Antigravity backup.');
    plan.antigravity = { bindings: extra.bindings, env: extra.env };
  }
  const subFile = path.join(dir, 'subagent.json');
  if (fs.existsSync(subFile)) {
    const sub = parseJson(textFile(subFile));
    if (!isRecord(sub.config) || typeof sub.config.apiKey !== 'string' || !isRecord(sub.config.targets) || !(sub.userKey == null || typeof sub.userKey === 'string')) throw conflict('Incomplete subagent backup.');
    plan.subagent = sub as SubagentSnapshot;
  }
  return commitFiles(db, entry.appType, `Restore ${id}`, plan, true);
}
