import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { SubagentProtocol, SubagentPythonInfo } from '../shared/types.js';
import { conflict } from './common.js';

export function bundledScript() {
  const file = path.resolve(import.meta.dirname, import.meta.filename.endsWith('.ts') ? '..' : '../..', 'subagent', 'astra_mcp_server.py');
  if (!fs.existsSync(file)) throw conflict('The bundled subagent server is missing.');
  return file;
}
const pythonName = /^(?:python(?:3(?:\.\d+)?)?|py)(?:\.exe)?$/i;
const stub = (p: string) => /(?:^|[\\/])WindowsApps(?:[\\/]|$)/i.test(p);
function interpreter(name: string) {
  if (!pythonName.test(path.basename(name)) || stub(name)) return null;
  if (path.isAbsolute(name)) return name;
  if (path.basename(name) !== name) return null;
  const file = process.platform === 'win32' && !name.endsWith('.exe') ? name + '.exe' : name;
  return (process.env.PATH ?? '').split(path.delimiter).filter(p => path.isAbsolute(p) && !stub(p)).map(p => path.join(p, file)).find(p => fs.existsSync(p)) ?? null;
}
const query = 'import json,sys;print(json.dumps([sys.executable,*sys.version_info[:3]]))';
const cache = new Map<string, { at: number; info: SubagentPythonInfo }>();
export function detectPython(custom?: string): SubagentPythonInfo {
  const key = custom ?? '', hit = cache.get(key);
  if (hit && Date.now() - hit.at < 30_000) return hit.info;
  let info: SubagentPythonInfo = { available: false, executable: null, version: null, meetsMinimum: false, error: 'Python 3.10 or later was not found.' };
  for (const candidate of custom ? [custom] : ['py', 'python', 'python3']) {
    const exe = interpreter(candidate); if (!exe) continue;
    try {
      const args = /^py(?:\.exe)?$/i.test(path.basename(exe)) ? ['-3'] : [];
      const [executable, major, minor, patch] = JSON.parse(execFileSync(exe, [...args, '-I', '-S', '-B', '-c', query], { encoding: 'utf8', timeout: 2500, maxBuffer: 8192, windowsHide: true, stdio: ['ignore','pipe','pipe'] }));
      if (typeof executable !== 'string' || !path.isAbsolute(executable) || stub(executable) || ![major, minor, patch].every(Number.isInteger)) continue;
      const meetsMinimum = major > 3 || (major === 3 && minor >= 10);
      info = { available: true, executable, version: `${major}.${minor}.${patch}`, meetsMinimum, ...(meetsMinimum ? {} : { error: 'Python 3.10 or later is required.' }) };
      if (meetsMinimum) break;
    } catch { /* Unavailable launcher or unsupported interpreter; do not return stderr. */ }
  }
  if (cache.size > 32) cache.clear();
  cache.set(key, { at: Date.now(), info }); return info;
}
const toolNames = ['astra_run_task','astra_spawn_worker','astra_worker_status','astra_wait_worker','astra_list_sessions','astra_compact_session'];
export async function handshake(executable: string, model: string, protocol: SubagentProtocol) {
  const script = bundledScript(), temp = fs.mkdtempSync(path.join(os.tmpdir(), 'phuket-mcp-test-'));
  try {
    const env = Object.fromEntries(['SystemRoot','WINDIR','PATH','TEMP','TMP','PHUKET_SWITCH_USER_HOME'].filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]));
    const child = spawn(executable, ['-I', '-S', '-B', '-u', script], { cwd: temp, windowsHide: true, stdio: ['pipe','pipe','ignore'], env: { ...env, PLUGIN_DATA: temp, ASTRA_MODEL: model, ASTRA_PROTOCOL: protocol } });
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
    try {
      return await new Promise<{ tools: string[]; version: string }>((resolve, reject) => {
        const fail = () => reject(new Error('MCP handshake failed.'));
        const timer = setTimeout(() => { fail(); child.kill(); }, 8000);
        const lines = createInterface({ input: child.stdout }); let version = '', bytes = 0;
        child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 128 * 1024) { fail(); child.kill(); } });
        child.once('error', fail); child.stdin.once('error', fail); child.once('close', () => { clearTimeout(timer); lines.close(); fail(); });
        const send = (message: object) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
        lines.on('line', line => {
          try {
            const { id, result } = JSON.parse(line);
            if (id === 1 && !version && result.serverInfo?.name === 'gpt-astra-subagent' && result._meta?.model === model && result._meta?.api_format === protocol) {
              version = result.serverInfo.version; send({ method: 'notifications/initialized' }); send({ id: 2, method: 'tools/list', params: {} });
            } else if (id === 2 && version === '1.4.0') {
              const tools = result.tools.map((t: { name: string }) => t.name);
              if (tools.length !== toolNames.length || !toolNames.every(t => tools.includes(t))) return fail();
              resolve({ tools, version });
            } else fail();
          } catch { fail(); }
        });
        send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Phuket Switch', version: '0.1' } } });
      });
    } finally { child.stdin.end(); child.kill(); await closed; }
  } finally { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3 }); }
}
