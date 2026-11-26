import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { directDownloadTargets, type ApplyDirectDownloadRequest, type ApplyDirectDownloadResult, type DirectDownloadConfig,
  type DirectDownloadDiffPreview, type DirectDownloadStatus, type DirectDownloadTarget as Id, type DirectDownloadTestRequest,
  type DirectDownloadTestResult, type RemoveDirectDownloadRequest } from '../shared/types.js';
import { bad, conflict, elapsed, getUserHome, now, redactRecognizable } from './common.js';
import { cliPaths, commitFiles, directDownloadPaths, jsonText, managedBytes, managedText, parseJson, subagentPaths, type Plan } from './configFiles.js';
import type { SwitchDb } from './db.js';
import { directDownloadBlock, downloadRouteArgs, editDirectDownloadBlock, effectiveDownloadRoute, renderDirectDownloadRule } from './directDownloadRules.js';
import { bundledDirectFile, childEnv, routeInfo } from './directFiles.js';
import { detectPython } from './subagentPython.js';
import { isLoopbackUrl } from './upstreamTransport.js';
import { testDirectDownload as testInput } from './validation.js';

const names: Record<Id, string> = { codex: 'Codex', 'claude-code': 'Claude Code', 'gemini-cli': 'Gemini CLI', antigravity: 'Antigravity', windsurf: 'Windsurf', opencode: 'OpenCode', cline: 'Cline' };
const pythonFiles = { script: 'direct_download.py', torrent: 'direct_torrent.py', net: 'direct_net.py', dns: 'direct_dns.py' } as const;
const runtimeKeys = ['script', 'torrent', 'net', 'dns', 'cmd'] as const;
function perTarget<T>(value: (id: Id) => T): Record<Id, T> {
  return Object.fromEntries(directDownloadTargets.map(id => [id, value(id)])) as Record<Id, T>;
}
function targetFiles() {
  const cli = cliPaths(), sub = subagentPaths(), dd = directDownloadPaths();
  const files: Record<Id, string> = { codex: cli.codexPrompt, 'claude-code': cli.claudePrompt, 'gemini-cli': sub.geminiRules,
    antigravity: dd.antigravityRules, windsurf: sub.windsurfRules, opencode: sub.opencodeRules, cline: dd.clineRules };
  return perTarget(id => ({ path: files[id], src: managedText(files[id]) }));
}
function liveTargets(files: ReturnType<typeof targetFiles>) {
  const sub = subagentPaths();
  return perTarget(id => {
    const { path: file, src } = files[id];
    const root = id === 'antigravity' ? path.join(getUserHome(), '.gemini', 'config') : id === 'windsurf' ? path.dirname(sub.windsurfMcp)
      : id === 'cline' ? path.join(getUserHome(), '.cline') : path.dirname(file);
    return { id, name: names[id], path: file, exists: src !== null, detected: src !== null || fs.lstatSync(root, { throwIfNoEntry: false })?.isDirectory() === true,
      injected: directDownloadBlock(src ?? '') !== null || (id === 'antigravity' && directDownloadBlock(managedText(sub.pluginRules) ?? '') !== null) };
  });
}
function stripLegacyDownloadRule(plan: Plan) {
  const file = subagentPaths().pluginRules, src = managedText(file);
  if (src && directDownloadBlock(src)) plan.set(file, editDirectDownloadBlock(src, null));
}
const pluginRule = './rules/AGENTS.md';
const pluginManifest = { name: 'phuket-direct-download', version: '1.0.0', displayName: 'Phuket Direct Download', rules: [pluginRule] };
function registerPlugin(plan: Plan, file: string, install: boolean) {
  const src = managedText(file);
  if (src === null) { if (install) plan.set(file, jsonText(pluginManifest)); return; }
  const manifest = parseJson(src);
  if (manifest.name !== pluginManifest.name || !Array.isArray(manifest.rules) || !manifest.rules.every(r => typeof r === 'string')) {
    throw conflict('Cannot update an unrecognized direct-download plugin manifest.');
  }
  if (install) {
    if (!manifest.rules.includes(pluginRule)) plan.set(file, jsonText({ ...manifest, rules: [...manifest.rules, pluginRule] }));
  } else if (src === jsonText(pluginManifest)) plan.set(file, null);
  else if (manifest.rules.includes(pluginRule)) plan.set(file, jsonText({ ...manifest, rules: manifest.rules.filter(r => r !== pluginRule) }));
}
const pythonFor = (db: SwitchDb) => detectPython(db.state('subagent').pythonPath);
function rule(db: SwitchDb, config: DirectDownloadConfig, python: ReturnType<typeof detectPython>) {
  return renderDirectDownloadRule(config, directDownloadPaths(), effectiveDownloadRoute(config, db.state('directBypass')), python.meetsMinimum ? python.executable : null);
}
export function getDirectDownloadStatus(db: SwitchDb): DirectDownloadStatus {
  const config = db.state('directDownload'), f = directDownloadPaths(), python = pythonFor(db);
  return { config, python, runtimeDir: f.dir, scriptPath: f.script, cmdPath: f.cmd,
    scriptInstalled: runtimeKeys.every(key => managedBytes(f[key]) !== null), liveTargets: liveTargets(targetFiles()), previewMarkdown: rule(db, config, python), updatedAt: now() };
}
function launcher(exe: string) {
  if (/["\x00-\x1f\x7f]/.test(exe)) throw bad('Unsafe interpreter path for the Windows launcher.');
  return `@echo off\r\nsetlocal DisableDelayedExpansion\r\n"${exe.replaceAll('%', '%%')}" -I -S -B -u "%~dp0direct_download.py" %*\r\n`;
}
function installPlan(db: SwitchDb, req: ApplyDirectDownloadRequest, preview: boolean) {
  const python = pythonFor(db), { targets, ...settings } = req;
  if (!preview && (!python.meetsMinimum || !python.executable)) throw bad('Python 3.10 or later is required to deploy the downloader.');
  const files = targetFiles(), live = liveTargets(files), f = directDownloadPaths(), plan: Plan = new Map();
  const config = { ...db.state('directDownload'), ...settings, enabled: true, targets: perTarget(id => targets.includes(id) || live[id].injected) };
  const block = rule(db, config, python);
  // Interface and path strings also appear in the block. Verify the delimiters before any commit.
  if (directDownloadBlock(block) !== block) throw bad('Invalid generated rule markers.');
  for (const id of targets) {
    if (id === 'antigravity') { stripLegacyDownloadRule(plan); registerPlugin(plan, f.antigravityPluginManifest, true); }
    const after = editDirectDownloadBlock(files[id].src ?? '', block);
    if (id === 'windsurf' && after.length > 12000) throw conflict('Windsurf global rules would exceed 12,000 characters; shorten the instructions or the existing file.');
    plan.set(files[id].path, after);
  }
  for (const key of runtimeKeys) plan.set(f[key], key === 'cmd' ? launcher(python.executable ?? 'python') : fs.readFileSync(bundledDirectFile(pythonFiles[key])));
  return { plan, config, block, python };
}
function previewText(db: SwitchDb) {
  const session = db.state('phuketSession');
  const keys = [db.state('imagePrompt').apiKey, db.state('subagent').apiKey, session?.token, session?.refreshToken,
    ...db.providers().map(p => p.apiKey)].filter((s): s is string => !!s).sort((a, b) => b.length-a.length);
  return (file: string, data: string | Buffer | null) => data === null ? null : file.endsWith('.py')
    ? `# Python script; ${Buffer.byteLength(data)} bytes; SHA-256 ${createHash('sha256').update(data).digest('hex')}`
    : redactRecognizable(keys.reduce((s, key) => s.replaceAll(key, '[REDACTED]'), data.toString()));
}
export function previewDirectDownload(db: SwitchDb, req: ApplyDirectDownloadRequest): DirectDownloadDiffPreview {
  const { plan, block, python } = installPlan(db, req, true), display = previewText(db);
  return { files: [...plan].map(([file, after]) => ({ path: file, before: display(file, managedBytes(file)), after: display(file, after) })),
    warnings: python.meetsMinimum ? [] : ['Python 3.10 or later is required to apply.'], previewMarkdown: display('', block)! };
}
function commit(db: SwitchDb, plan: Plan, config: DirectDownloadConfig, reason: string): ApplyDirectDownloadResult {
  const dirty = JSON.stringify(config) !== JSON.stringify(db.state('directDownload')) || [...plan].some(([file, value]) => {
    const original = managedBytes(file);
    return value === null ? original !== null : !original?.equals(typeof value === 'string' ? Buffer.from(value) : value);
  });
  if (dirty) config.updatedAt = now();
  plan.directDownload = { config };
  const system = commitFiles(db, 'codex', reason, plan);
  return { system, status: getDirectDownloadStatus(db) };
}
export function applyDirectDownload(db: SwitchDb, req: ApplyDirectDownloadRequest) {
  const { plan, config } = installPlan(db, req, false);
  return commit(db, plan, config, 'Apply direct downloader');
}
export function removeDirectDownload(db: SwitchDb, req: RemoveDirectDownloadRequest) {
  const files = targetFiles(), live = liveTargets(files), f = directDownloadPaths(), plan: Plan = new Map();
  for (const id of req.targets) {
    if (id === 'antigravity') stripLegacyDownloadRule(plan);
    const src = files[id].src;
    if (src === null || !directDownloadBlock(src)) continue;
    const rest = editDirectDownloadBlock(src, null), empty = !rest.trim();
    if (id === 'antigravity' && empty) registerPlugin(plan, f.antigravityPluginManifest, false);
    plan.set(files[id].path, (id === 'cline' || id === 'antigravity') && empty ? null : rest);
  }
  const targets = perTarget(id => !req.targets.includes(id) && live[id].injected), enabled = Object.values(targets).some(Boolean);
  if (!enabled && req.removeScripts !== false) for (const key of runtimeKeys) plan.set(f[key], null);
  return commit(db, plan, { ...db.state('directDownload'), targets, enabled }, 'Remove direct downloader');
}

const run = promisify(execFile);
const selfCheck = z.object({ ok: z.literal(true), version: z.string().max(64).regex(/^\d+\.\d+\.\d+$/), capabilities: z.array(z.string().regex(/^[a-z0-9-]{1,64}$/)).max(64) });
const httpInfo = z.object({ ok: z.literal(true), finalUrl: testInput.shape.url.unwrap(), filename: z.string().max(255).optional(),
  totalSize: z.int().nonnegative().nullable().optional(), acceptRanges: z.boolean().optional(), contentType: z.string().max(4096).nullish(), route: routeInfo.nullish() });
export async function testDirectDownload(db: SwitchDb, req: DirectDownloadTestRequest): Promise<DirectDownloadTestResult> {
  const start = performance.now(), python = pythonFor(db), exe = python.executable;
  const result: DirectDownloadTestResult = { ok: false, latencyMs: 0, pythonExecutable: exe, pythonVersion: python.version, scriptVersion: null, capabilities: [], testedAt: now() };
  if (!python.meetsMinimum || !exe) result.error = 'Python 3.10 or later is required.';
  else try {
    const f = directDownloadPaths(), deployed = managedBytes(f.script) !== null;
    if (deployed && !(['torrent', 'net', 'dns'] as const).every(key => managedBytes(f[key]) !== null)) throw new Error();
    const script = deployed ? f.script : bundledDirectFile('direct_download.py');
    async function invoke(args: string[]) {
      const timeout = 12000 - elapsed(start);
      if (timeout <= 0) throw new Error();
      const { stdout } = await run(exe!, ['-I', '-S', '-B', '-u', script, ...args], { cwd: path.dirname(script), env: childEnv(),
        timeout, maxBuffer: 64*1024, encoding: 'utf8', windowsHide: true });
      return JSON.parse(stdout) as unknown;
    }
    const check = selfCheck.parse(await invoke(['--self-check']));
    result.scriptVersion = check.version; result.capabilities = check.capabilities;
    if (req.url) {
      const route = effectiveDownloadRoute(db.state('directDownload'), db.state('directBypass'));
      const args = isLoopbackUrl(new URL(req.url)) ? ['--system-route'] : downloadRouteArgs(route);
      const { finalUrl, filename, totalSize, acceptRanges, contentType, route: selected } = httpInfo.parse(await invoke([...args, '--info', '--json', '--timeout', '10', '--', req.url]));
      result.probe = { url: req.url, finalUrl, filename, totalSize, acceptRanges, contentType: contentType ?? undefined, route: selected ?? null };
    }
    result.ok = true;
  } catch { result.error = result.scriptVersion ? 'The HTTP metadata probe failed or timed out on the selected route.' : 'Downloader self-check failed; check the Python runtime or reapply the scripts.'; }
  result.latencyMs = elapsed(start);
  return result;
}
