import fs from 'node:fs';
import path from 'node:path';
import type { AppType, McpServerItem, McpTarget, McpTransport, SkillItem, UpsertMcpRequest } from '../shared/types.js';
import type { SwitchDb } from './db.js';
import { bad, conflict, getUserHome, isRecord, missing, own, secretField } from './common.js';
import { cliPaths, commitFiles, jsonText, parseJson, textFile } from './configFiles.js';
import { parseToml, replaceTomlSubtree } from './surgicalToml.js';
import { editSubagentBlock, subagentBlock } from './subagentRules.js';
import { managedText } from './configFiles.js';
import { hasImagePromptBlock, mergeImagePromptBlock, renderImagePromptBlock } from './imagePrompt.js';

const mask = '[REDACTED]';
function config(target: McpTarget) {
  const file = target === 'claude' ? cliPaths().claudeMcp : cliPaths().codex;
  const src = textFile(file), doc = target === 'claude' ? parseJson(src) : parseToml(src ?? '');
  const key = target === 'claude' ? 'mcpServers' : 'mcp_servers';
  if (doc[key] !== undefined && !isRecord(doc[key])) throw conflict('MCP servers must be a table.');
  return { file, src, doc, servers: own(doc[key]) };
}
function dictionary(v: unknown) { return Object.fromEntries(Object.entries(own(v)).filter((kv): kv is [string, string] => typeof kv[1] === 'string')); }
function secretMap(v: unknown) { return Object.fromEntries(Object.entries(dictionary(v)).map(([k, v]) => [k, secretField(k) || /^(?:Bearer |Basic |sk-|eyJ|ghp_|AKIA)/i.test(v) ? mask : v])); }
function restoreSecrets(values: Record<string, string> | undefined, previous: unknown) {
  if (!values) return undefined;
  return Object.fromEntries(Object.entries(values).map(([k, v]) => {
    if (v === mask && !Object.hasOwn(own(previous), k)) throw bad('Supply the original value for a new secret.');
    return [k, v === mask ? own(previous)[k] : v];
  }));
}
function mcpItem(target: McpTarget, name: string, data: Record<string, any>, doc: Record<string, any>): McpServerItem {
  const h = data.http_headers ?? data.headers;
  const transport: McpTransport = typeof data.url === 'string' ? { type: data.type === 'sse' ? 'sse' : 'http', url: data.url, ...(h ? { headers: secretMap(h) } : {}) } : { type: 'stdio', command: String(data.command ?? ''), args: Array.isArray(data.args) ? data.args.map(String) : [], ...(data.env ? { env: secretMap(data.env) } : {}) };
  return { id: `${target}:${name}`, target, name, transport, enabled: data.enabled !== false && !data.disabled && !(Array.isArray(doc.disabledMcpServers) && doc.disabledMcpServers.includes(name)) };
}
export function listMcp() { return (['claude','codex'] as const).flatMap(t => { const c = config(t); return Object.entries(c.servers).map(([k, v]) => mcpItem(t, k, own(v), c.doc)); }); }
function writeMcp(db: SwitchDb, target: McpTarget, name: string, req: UpsertMcpRequest | null) {
  const c = config(target), previous = own(c.servers[name]), v = req?.transport;
  if (!req && !Object.hasOwn(c.servers, name)) throw missing('MCP server');
  const enabled = req?.enabled ?? mcpItem(target, name, previous, c.doc).enabled;
  const env = v?.type === 'stdio' ? restoreSecrets(v.env, previous.env) : undefined;
  const headers = v && v.type !== 'stdio' ? restoreSecrets(v.headers, previous.headers ?? previous.http_headers) : undefined;
  const changed: Record<string, any> | null = !v ? null : { ...(target === 'codex' ? { enabled } : { type: v.type }), ...(v.type === 'stdio' ? { command: v.command, args: v.args, ...(env ? { env } : {}) } : { url: v.url, ...(v.type === 'sse' ? { type: 'sse' } : {}), ...(headers ? { [target === 'codex' ? 'http_headers' : 'headers']: headers } : {}) }) };
  let after: string;
  if (target === 'claude') {
    const servers = { ...c.servers }; if (!changed) delete servers[name]; else servers[name] = changed;
    const disabled = new Set(Array.isArray(c.doc.disabledMcpServers) ? c.doc.disabledMcpServers : []);
    if (req && !enabled) disabled.add(name); else disabled.delete(name);
    after = jsonText({ ...c.doc, mcpServers: servers, ...(disabled.size || c.doc.disabledMcpServers ? { disabledMcpServers: [...disabled] } : {}) });
  } else after = replaceTomlSubtree(c.src ?? '', ['mcp_servers', name], changed);
  commitFiles(db, target, req ? 'Save MCP server' : 'Remove MCP server', new Map([[c.file, after]]));
}
export function upsertMcp(db: SwitchDb, req: UpsertMcpRequest) { writeMcp(db, req.target, req.name, req); const c = config(req.target); return mcpItem(req.target, req.name, c.servers[req.name], c.doc); }
export function deleteMcp(db: SwitchDb, target: McpTarget, name: string) { writeMcp(db, target, name, null); }
export function applyPrompt(db: SwitchDb, id: string) {
  const p = db.prompt(id), f = cliPaths(), img = db.state('imagePrompt'), target = p.appType === 'claude' || p.appType === 'codex' ? p.appType : null;
  const content = img.enabled && img.apiKey && target && img.targets[target] && !hasImagePromptBlock(p.content)
    ? mergeImagePromptBlock(p.content, renderImagePromptBlock(img))
    : p.content;
  const file = p.appType === 'claude' ? f.claudePrompt : f.codexPrompt;
  const live = subagentBlock(managedText(file) ?? '');
  const result = commitFiles(db, p.appType, 'Apply prompt preset', new Map([[file, live ? editSubagentBlock(content, live) : content]])); db.enablePrompt(p); return result;
}
function frontmatter(content: string) {
  const block = /^\uFEFF?---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1] ?? '';
  const field = (key: string) => {
    const m = new RegExp(`^${key}:[ \\t]*(.*?)[ \\t]*\\r?$`, 'm').exec(block);
    if (!m) return ''; const raw = m[1];
    if (/^[|>][-+]?$/.test(raw)) return (block.slice(m.index + m[0].length).match(/^(?:\r?\n[ \t]+[^\n]*)+/)?.[0] ?? '').trim().replace(/\s+/g, ' ');
    return raw.replace(/^(?:"(.*)"|'(.*)')$/, (_m, a: string, b: string) => a ?? b);
  };
  return { name: field('name'), description: field('description') };
}
export function listSkills(): SkillItem[] {
  const result: SkillItem[] = [], home = getUserHome();
  for (const source of ['claude','codex','cc-switch'] as const) {
    const base = path.join(home, `.${source}`, 'skills');
    const scan = (dir: string, depth: number) => {
      if (!fs.lstatSync(dir, { throwIfNoEntry: false })?.isDirectory() || depth > 3) return;
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!ent.isDirectory() || ent.name === '.git') continue;
        const folder = path.join(dir, ent.name), file = path.join(folder, 'SKILL.md'), stat = fs.lstatSync(file, { throwIfNoEntry: false });
        if (!stat?.isFile()) { if (ent.name.startsWith('.') || source === 'cc-switch') scan(folder, depth + 1); continue; }
        if (stat.size > 1024 * 1024) continue;
        const content = fs.readFileSync(file, 'utf8'), meta = frontmatter(content), appTypes: AppType[] = source === 'cc-switch' ? ['claude','codex'] : [source];
        result.push({ id: `${source}:${path.relative(base, folder)}`, name: meta.name || ent.name, description: meta.description, appTypes, content, enabled: true });
      }
    }; scan(base, 0);
  }
  return result;
}
