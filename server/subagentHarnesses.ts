import fs from 'node:fs';
import path from 'node:path';
import type { DirectBypassConfig, DirectDownloadConfig } from '../shared/types.js';
import { bundledDirectFile } from './directFiles.js';
import { subagentHarnessIds, subagentProtocols, type SubagentConfig, type SubagentHarnessId as Id, type SubagentHarnessState } from '../shared/types.js';
import { conflict, getUserHome, isRecord, own } from './common.js';
import { directDownloadPaths, jsonText, managedText, parseJson, subagentPaths, type Plan } from './configFiles.js';
import { parseToml, replaceTomlSubtree } from './surgicalToml.js';
import { editSubagentBlock, subagentBlock } from './subagentRules.js';
import { renderSubagentRules as ruleText, renderSubagentSkill, withoutLegacyNativeRules } from './subagentTemplates.js';

export type StoredConfig = SubagentConfig & { apiKey: string };
export const serverName = 'gpt-astra-subagent';
const names: Record<Id, string> = { antigravity: 'Antigravity', 'claude-code': 'Claude Code', codex: 'Codex', 'gemini-cli': 'Gemini CLI', 'claude-desktop': 'Claude Desktop', cursor: 'Cursor', windsurf: 'Windsurf', opencode: 'OpenCode', cline: 'Cline' };
const dirExists = (p: string) => fs.lstatSync(p, { throwIfNoEntry: false })?.isDirectory() === true;
export const useUserEnv = (c: SubagentConfig) => c.keyStorage === 'user-env' && process.platform === 'win32';
function paths(id: Id) {
  const f = subagentPaths();
  const files: Record<Id, [string[], string | null, string]> = {
    antigravity: [[f.pluginMcp], f.pluginRules, path.join(getUserHome(), '.gemini', 'config')],
    'claude-code': [[f.claudeMcp], f.claudeRules, path.dirname(f.claudeRules)], codex: [[f.codexMcp], f.codexRules, path.dirname(f.codexMcp)],
    'gemini-cli': [[f.geminiMcp], f.geminiRules, path.dirname(f.geminiMcp)],
    'claude-desktop': [[f.desktopMcp], null, path.dirname(f.desktopMcp)], cursor: [[f.cursorMcp], null, path.dirname(f.cursorMcp)],
    windsurf: [[f.windsurfMcp], f.windsurfRules, path.dirname(f.windsurfMcp)], opencode: [[f.opencodeMcp], f.opencodeRules, path.dirname(f.opencodeMcp)],
    cline: [[f.clineMcp], f.clineRules, path.join(getUserHome(), '.cline')],
  };
  const [mcp, rules, root] = files[id];
  if (id === 'claude-desktop' && dirExists(path.dirname(f.desktop3pMcp))) {
    if (!dirExists(root)) mcp.length = 0;
    mcp.push(f.desktop3pMcp);
  }
  if (id === 'cline' && dirExists(path.dirname(f.clineVsMcp))) mcp.splice(0, 1, f.clineVsMcp);
  return { mcp, rules, root };
}
function entry(id: Id, c: StoredConfig, command: string, direct: DirectBypassConfig, download: DirectDownloadConfig, masked = false) {
  const f = subagentPaths(), args = ['-u', id === 'antigravity' ? f.pluginServer : f.runtime];
  const env = { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1',
    ASTRA_BASE_URL: c.baseUrl, ASTRA_MODEL: c.model, ASTRA_PROTOCOL: c.protocol, ASTRA_DEFAULT_REASONING_EFFORT: c.reasoningEffort, ASTRA_REASONING_EFFORT: c.reasoningEffort,
    ASTRA_DEFAULT_MODE: c.defaultMode, ASTRA_ALLOW_MODEL_OVERRIDE: c.allowModelOverride ? '1' : '0', ASTRA_MAX_CONTEXT_TOKENS: String(c.maxContextTokens),
    ASTRA_ALLOW_MODEL_COMPACTION: c.enableChunkCompaction ? '1' : '0',
    ASTRA_COMPACT_TRIGGER_TOKENS: String(Math.max(5584, Math.min(c.maxContextTokens, Math.round(c.maxContextTokens * c.compactTriggerPct / 100)))),
    ASTRA_COMPACT_KEEP_RECENT_GROUPS: String(c.compactKeepRecentGroups),
    ...(download.enabled ? { ASTRA_DIRECT_DOWNLOAD_SCRIPT: directDownloadPaths().script } : {}),
    ...(direct.enabled && direct.applyToSubagent ? { ASTRA_DIRECT_BYPASS: direct.mode,
      ...(direct.interfaceName ? { ASTRA_DIRECT_INTERFACE: direct.interfaceName } : {}),
      ...(direct.dnsServers.length ? { ASTRA_DIRECT_DNS: direct.dnsServers.join(',') } : {}) } : {}),
    ASTRA_KEY_STORAGE: useUserEnv(c) ? 'user-env' : 'mcp-env',
    ...(process.env.PHUKET_SWITCH_USER_HOME !== undefined ? { PHUKET_SWITCH_USER_HOME: getUserHome() } : {}),
    ...(!useUserEnv(c) && c.apiKey ? { ASTRA_API_KEY: masked ? '[REDACTED]' : c.apiKey } : {}) };
  if (id === 'opencode') return { type: 'local', command: [command, ...args], environment: env, enabled: true };
  return { command, args, env, ...(id === 'claude-code' ? { type: 'stdio' } : id === 'codex' ? { enabled: true, startup_timeout_sec: 30, tool_timeout_sec: 300 } :
    id === 'gemini-cli' ? { timeout: 300000 } : id === 'cline' ? { disabled: false, autoApprove: [] } : {}) };
}
function configNode(id: Id, src: string | null) {
  const doc = id === 'codex' ? parseToml(src ?? '') : parseJson(src), key = id === 'codex' ? 'mcp_servers' : id === 'opencode' ? 'mcp' : 'mcpServers';
  if (doc[key] !== undefined && !isRecord(doc[key])) throw conflict('MCP servers must be a table.');
  return { doc, key, servers: own(doc[key]) };
}
function renderMcp(id: Id, src: string | null, value: ReturnType<typeof entry> | null) {
  const { doc, key, servers } = configNode(id, src);
  if (!value && !Object.hasOwn(servers, serverName)) return src;
  if (id === 'codex') return replaceTomlSubtree(src ?? '', [key, serverName], value);
  const next = { ...servers };
  if (value) next[serverName] = value; else delete next[serverName];
  if (id === 'antigravity' && !value && !Object.keys(next).length && Object.keys(doc).length === 1) return null;
  return jsonText({ ...doc, [key]: next });
}
export function harnessStates(c: StoredConfig, exe: string, direct: DirectBypassConfig, download: DirectDownloadConfig): SubagentHarnessState[] {
  return subagentHarnessIds.map(id => {
    const p = paths(id), value = entry(id, c, exe, direct, download, true), notes: string[] = [];
    const rulesSnippet = (id === 'cursor' ? '---\ndescription: Phuket subagent\nalwaysApply: true\n---\n' : '') + ruleText(c, id);
    const state: SubagentHarnessState = { id, name: names[id], detected: dirExists(p.root), installed: false, rulesInstalled: false, supportsRules: !!p.rules,
      installedModel: null, installedProtocol: null, mcpPath: p.mcp[0], rulesPath: p.rules, snippet: renderMcp(id, null, value)!, rulesSnippet, notes };
    if (!p.rules) notes.push(id === 'cursor' ? 'Paste the rule in .cursor/rules/phuket-subagent.mdc.' : 'Paste the rule manually into your project instructions.');
    if (p.mcp.length > 1) notes.push('Also manages: ' + p.mcp.slice(1).join(', '));
    try {
      for (const file of p.mcp) {
        const src = managedText(file); state.detected ||= src !== null || (id !== 'claude-code' && dirExists(path.dirname(file)));
        const server = configNode(id, src).servers[serverName];
        if (isRecord(server)) {
          state.installed = true;
          const env = own(server.env ?? server.environment);
          state.installedModel = typeof env.ASTRA_MODEL === 'string' ? env.ASTRA_MODEL : null;
          state.installedProtocol = subagentProtocols.includes(env.ASTRA_PROTOCOL) ? env.ASTRA_PROTOCOL : null;
        }
      }
      if (p.rules) state.rulesInstalled = !!subagentBlock(managedText(p.rules) ?? '');
    } catch { notes.push('Configuration is invalid or is not a regular managed path.'); }
    return state;
  });
}
export function checkUserKeyDestinations(c: StoredConfig, plan: Plan) {
  if (!useUserEnv(c) || !c.apiKey) return;
  const f = subagentPaths();
  for (const id of subagentHarnessIds) {
    for (const file of id === 'cline' ? [f.clineMcp, f.clineVsMcp] : paths(id).mcp) {
      if (plan.has(file)) continue;
      const src = managedText(file); if (src === null) continue;
      const server = own(configNode(id, src).servers[serverName]), env = own(server.environment ?? server.env);
      if (typeof env.ASTRA_BASE_URL === 'string' && !env.ASTRA_API_KEY && URL.parse(env.ASTRA_BASE_URL)?.origin !== new URL(c.baseUrl).origin) {
        throw conflict('Another harness uses the Windows user key at a different origin. Update it too, or select MCP key storage.');
      }
    }
  }
}
export function installPlan(ids: Id[], c: StoredConfig, exe: string, script: string, direct: DirectBypassConfig, download: DirectDownloadConfig): Plan {
  const f = subagentPaths(), plan: Plan = new Map();
  const helpers = (dns: string, net: string) => {
    if (direct.enabled && direct.applyToSubagent) {
      plan.set(dns, fs.readFileSync(bundledDirectFile('direct_dns.py'), 'utf8'));
      plan.set(net, fs.readFileSync(bundledDirectFile('direct_net.py'), 'utf8'));
    }
  };
  if (ids.some(id => id !== 'antigravity')) { plan.set(f.runtime, script); helpers(f.runtimeDirectDns, f.runtimeDirectNet); }
  for (const id of ids) {
    const p = paths(id), block = ruleText(c, id);
    for (const file of p.mcp) plan.set(file, renderMcp(id, managedText(file), entry(id, c, exe, direct, download)));
    if (p.rules) {
      const before = managedText(p.rules);
      const src = id === 'antigravity' ? withoutLegacyNativeRules(before ?? '') : before ?? '';
      if (c.writeRules || before !== null) plan.set(p.rules, editSubagentBlock(src, c.writeRules ? block : null));
    }
    if (id === 'antigravity') {
      const manifest = parseJson(managedText(f.pluginManifest));
      if (manifest.mcpServers === './mcp_config.json') delete manifest.mcpServers; // Stage 1 used the wrong manifest key.
      plan.set(f.pluginManifest, jsonText({ ...manifest, name: serverName, version: '1.4.0', displayName: `${c.model} Subagent`,
        description: `Plan and review with Antigravity; delegate workspace tasks to ${c.model} via ${c.protocol}.`,
        author: manifest.author ?? 'Phuket Switch', keywords: ['subagent', 'mcp', 'coding', c.protocol],
        mcpConfig: './mcp_config.json', rules: c.writeRules ? ['./rules/AGENTS.md'] : [], skills: ['./skills'],
        suggestedPrompts: [`规划当前项目的改造方案，并交由 ${c.model} 子代理完成实现与测试`, `并行派出多个 ${c.model} 子代理分别修改不同模块并汇总验收`, `让 ${c.model} 在只读模式下审查当前代码变更并给出修复建议`],
      }));
      plan.set(f.pluginServer, script); helpers(f.pluginDirectDns, f.pluginDirectNet);
      plan.set(f.pluginSkill, renderSubagentSkill(c));
    }
  }
  return plan;
}
export function uninstallPlan(ids: Id[], removeRules: boolean, c: StoredConfig): Plan {
  const plan: Plan = new Map(), f = subagentPaths();
  for (const id of ids) {
    const p = paths(id);
    const candidates = id === 'cline' ? [f.clineMcp, f.clineVsMcp] : p.mcp;
    for (const file of candidates) {
      const src = managedText(file);
      if (src !== null) plan.set(file, renderMcp(id, src, null));
    }
    if (removeRules && p.rules) {
      const src = managedText(p.rules);
      if (src !== null && subagentBlock(src)) {
        const rest = editSubagentBlock(src, null);
        plan.set(p.rules, (id === 'cline' || id === 'antigravity') && !rest.trim() ? null : rest);
      }
    }
    if (id === 'antigravity') {
      for (const file of [f.pluginServer, f.pluginDirectDns, f.pluginDirectNet, f.pluginSkill, f.pluginManifest]) plan.set(file, null);
    }
  }
  // Unselected harnesses (including a second Cline installation) may still use this script.
  const stillUsed = subagentHarnessIds.some(id => id !== 'antigravity' && !ids.includes(id) &&
    (id === 'cline' ? [f.clineMcp, f.clineVsMcp] : paths(id).mcp).some(file => {
      try { return !!configNode(id, managedText(file)).servers[serverName]; } catch { return true; }
    }));
  if (!stillUsed && ids.some(id => id !== 'antigravity') && Object.values(c.targets).some(Boolean)) {
    for (const file of [f.runtime, f.runtimeDirectDns, f.runtimeDirectNet]) plan.set(file, null);
  }
  return plan;
}
