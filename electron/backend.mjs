import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const projectRoot = path.dirname(import.meta.dirname);
const port = process.env.PHUKET_SWITCH_PORT || '15720';
if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('Invalid PHUKET_SWITCH_PORT');
export const backendURL = new URL(`http://127.0.0.1:${port}`);
let ownedBackendChild = null, draining = null;

export function webURL(value) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value) || /[\\\x00-\x1f\x7f]/.test(value)) return null;
  const url = URL.parse(value);
  return url?.hostname && !url.username && !url.password ? url : null;
}
export function selectUiURL(isPackaged, devUrl) {
  if (isPackaged || !devUrl) return backendURL;
  const url = webURL(devUrl);
  if (!url || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('PHUKET_DEV_URL must be a loopback HTTP(S) URL.');
  return url;
}
export function parseResolvedProxy(value) {
  for (const entry of value.split(';')) {
    if (/^DIRECT$/i.test(entry.trim())) break;
    const match = /^(PROXY|HTTPS)\s+([^\s/@?#\\]+)$/i.exec(entry.trim());
    if (!match) continue;
    try { return new URL(`${match[1].toUpperCase() === 'HTTPS' ? 'https' : 'http'}://${match[2]}`).origin; } catch { /* Try the next PAC entry. */ }
  }
  return undefined;
}
export function mergeNoProxy(...values) {
  return [...new Set(values.flatMap(v => (v || '').split(',')).map(v => v.trim()).filter(Boolean))].join(',');
}
export function backendEnvironment(env, systemProxy) {
  const bypass = mergeNoProxy(env.NO_PROXY, env.no_proxy, '127.0.0.1,localhost,::1');
  const explicit = [env.HTTPS_PROXY, env.https_proxy, env.HTTP_PROXY, env.http_proxy].some(v => v?.trim());
  return { ...env, NODE_USE_ENV_PROXY: '1', NO_PROXY: bypass, no_proxy: bypass,
    ...(!explicit && systemProxy ? { HTTP_PROXY: systemProxy, HTTPS_PROXY: systemProxy, PHUKET_SYSTEM_PROXY: systemProxy } : {}) };
}
export async function request(route, { method = 'GET', body, timeout = method === 'GET' ? 1200 : 15000 } = {}) {
  // Health checks and tray commands must also stay local if the parent opted Node into an env proxy.
  const data = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${backendURL.origin}/api${route}`, { method, agent: false, signal: AbortSignal.timeout(timeout),
      headers: data === undefined ? {} : { 'Content-Type': 'application/json' } }, res => {
      if (res.statusCode < 200 || res.statusCode >= 300) { res.resume(); reject(new Error(`${method} /api${route}: HTTP ${res.statusCode}`)); return; }
      const chunks = []; res.on('error', reject); res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.end(data);
  });
}

async function healthy(timeout) {
  try {
    const result = await request('/health', { timeout });
    return result.ok === true && result.app === 'phuket-switch' && result.apiVersion === 1;
  } catch { return false; }
}

export async function ensureBackend(isQuitting, systemProxy) {
  if (await healthy(800) || isQuitting()) return;
  const child = spawn(process.execPath, ['--require', path.join(import.meta.dirname, 'backend-lifetime.cjs'), path.join(projectRoot, 'dist/server/index.js')], {
    cwd: projectRoot, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { ...backendEnvironment(process.env, systemProxy), ELECTRON_RUN_AS_NODE: '1', PORT: port, PHUKET_SWITCH_PORT: port },
  });
  ownedBackendChild = child;
  child.once('exit', () => { if (ownedBackendChild === child) ownedBackendChild = null; });
  const deadline = Date.now() + 12000;
  try { await once(child, 'spawn'); }
  catch (error) { throw new Error(`Could not start the bundled backend: ${error.message}`); }
  while (!isQuitting()) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    if (await healthy(Math.min(800, left))) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`The backend exited during startup. Check the build and port ${port}.`);
    }
    await delay(Math.max(0, Math.min(150, deadline - Date.now())));
  }
  if (!isQuitting()) throw new Error(`The backend did not become ready on port ${backendURL.port} within 12 seconds.`);
}

async function closeChild(child) {
  // Electron's Node mode can exit without a 'close' notification after IPC disconnects.
  const exited = once(child, 'exit');
  const force = setTimeout(() => child.kill(), 3000);
  try {
    if (child.connected) child.disconnect(); else child.kill();
    await exited;
  } finally { clearTimeout(force); ownedBackendChild = null; }
}

export function stopOwnedBackend() {
  const child = ownedBackendChild;
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return null;
  return draining ??= closeChild(child);
}
