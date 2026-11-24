import { execFile, spawn, type ChildProcessByStdio } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { promisify } from 'node:util';
import { z } from 'zod';
import { PHUKET_BASE_URL } from '../shared/constants.js';
import type { DirectBypassConfig, DirectBypassProbeRequest, DirectBypassProbeResult, DirectBypassRouteInfo, DirectBypassStatus, UpdateDirectBypassRequest } from '../shared/types.js';
import { ApiError, elapsed, now } from './common.js';
import type { SwitchDb } from './db.js';
import { bundledDirectFile } from './directFiles.js';
import { detectPython } from './subagentPython.js';
import { adaptiveFetch, connectAuthority, isLoopbackUrl, setDirectBypassResolver, type DirectPolicy } from './upstreamTransport.js';

export interface DirectBypassOptions { /** Exercise the real bridge without requiring Windows hardware in tests. */ systemRoute?: boolean }
const timeout = 8000, outputLimit = 256 * 1024, run = promisify(execFile);
const routeInfo = z.object({ name: z.string(), description: z.string(), index: z.int().nullable(), ipv4: z.string().nullable(), ipv6: z.string().nullable(),
  gateway: z.string().nullable(), dnsServers: z.array(z.string()), metric: z.int().nullable(), systemRoute: z.boolean() });
const startup = z.object({ ok: z.literal(true), port: z.int().min(1).max(65535), route: routeInfo });
const inventory = z.object({ ok: z.literal(true), selected: routeInfo.nullable(), adapters: z.array(routeInfo) });
const unavailable = (message = 'Physical network route unavailable. Check the adapter and DNS settings.') => new ApiError(502, 'DIRECT_BYPASS_UNAVAILABLE', message);
const safeError = (err: unknown) => err instanceof ApiError && err.code === 'DIRECT_BYPASS_UNAVAILABLE' ? err : unavailable();
function childEnv(): NodeJS.ProcessEnv {
  const keys = ['SystemRoot', 'WINDIR', 'PATH', 'ComSpec', 'TEMP', 'TMP', 'SystemDrive', 'PSModulePath'];
  return Object.fromEntries(keys.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]));
}
function argsFor(config: DirectBypassConfig) {
  return [...(config.interfaceName ? [`--interface=${config.interfaceName}`] : []), ...(config.dnsServers.length ? ['--dns', ...config.dnsServers] : [])];
}
type Child = ChildProcessByStdio<Writable, Readable, null>;
interface Bridge { child: Child; closed: Promise<void>; url: URL; scopeKey: string; route: DirectBypassRouteInfo; signature: string }
function readStartup(child: Child) {
  return new Promise<z.infer<typeof startup>>((resolve, reject) => {
    let text = '';
    const fail = () => finish();
    const timer = setTimeout(() => finish(undefined, unavailable('Direct bridge did not start within 8 seconds.')), timeout);
    function finish(data?: z.infer<typeof startup>, error = unavailable()) {
      clearTimeout(timer); child.stdout.off('data', onData); child.off('error', fail); child.off('close', fail);
      if (data) resolve(data); else reject(error);
    }
    function onData(chunk: Buffer) {
      text += chunk.toString('ascii'); // The bridge emits ASCII JSON with escaped Unicode.
      if (text.length > outputLimit) return fail();
      if (text.includes('\n')) {
        try { finish(startup.parse(JSON.parse(text))); } catch { fail(); }
      }
    }
    child.once('error', fail); child.once('close', fail); child.stdout.on('data', onData);
  });
}
async function stop(bridge: Bridge) {
  bridge.child.stdin.end();
  const force = setTimeout(() => bridge.child.kill(), 400);
  try { await bridge.closed; } finally { clearTimeout(force); }
}

export class DirectBypassManager {
  private queue: Promise<void> = Promise.resolve();
  private bridge?: Bridge;
  private selected: DirectBypassRouteInfo | null = null;
  private adapters: DirectBypassRouteInfo[] = [];
  private error: string | null = null;
  private closing = false;
  private unregister: () => void;
  constructor(private readonly db: SwitchDb, private readonly options: DirectBypassOptions = {}) {
    this.unregister = setDirectBypassResolver(url => this.resolvePolicy(url));
  }
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(unavailable('Direct transport has closed.'));
    const job = this.queue.then(task);
    this.queue = job.then(() => {}, () => {});
    return job;
  }
  private command() {
    const python = detectPython(this.db.state('subagent').pythonPath);
    if (!python.meetsMinimum || !python.executable) throw unavailable('Direct transport requires Python 3.10 or later.');
    const script = bundledDirectFile('direct_bridge.py');
    return { exe: python.executable, args: ['-I', '-S', '-B', '-u', script], cwd: dirname(script) };
  }
  private snapshot(): DirectBypassStatus {
    return { config: this.db.state('directBypass'), bridgeRunning: !!this.bridge, selected: this.bridge?.route ?? this.selected, adapters: this.adapters, error: this.error };
  }
  getStatus({ refreshAdapters = false } = {}) {
    return this.exclusive(async () => {
      if (refreshAdapters && !this.options.systemRoute) {
        try {
          const cmd = this.command();
          const { stdout } = await run(cmd.exe, [...cmd.args, '--inspect-routes', ...argsFor(this.db.state('directBypass'))],
            { cwd: cmd.cwd, env: childEnv(), windowsHide: true, timeout, maxBuffer: outputLimit, encoding: 'utf8' });
          const data = inventory.parse(JSON.parse(stdout));
          this.selected = data.selected; this.adapters = data.adapters;
          if (this.bridge || !this.db.state('directBypass').enabled) this.error = null;
        } catch (err) { this.selected = null; this.adapters = []; this.error = safeError(err).message; }
      }
      return this.snapshot();
    });
  }
  private async stopBridge() {
    const old = this.bridge; this.bridge = undefined;
    if (old) await stop(old);
  }
  private async apply(config: DirectBypassConfig) {
    if (!config.enabled || config.mode === 'skip-proxy') { await this.stopBridge(); this.error = null; return; }
    const args = argsFor(config), signature = JSON.stringify([this.db.state('subagent').pythonPath, args]);
    if (this.bridge?.signature === signature) return;
    await this.stopBridge();
    try {
      const cmd = this.command(), token = randomBytes(32).toString('hex'), scopeKey = randomBytes(32).toString('hex');
      const child = spawn(cmd.exe, [...cmd.args, '--serve', ...(this.options.systemRoute ? ['--system-route'] : []), ...args],
        { cwd: cmd.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], env: { ...childEnv(), DIRECT_BRIDGE_TOKEN: token, DIRECT_BRIDGE_SCOPE_KEY: scopeKey } });
      child.stdin.on('error', () => {}); // An EOF racing process exit is expected.
      const closed = new Promise<void>(resolve => child.once('close', () => {
        if (this.bridge?.child === child) { this.bridge = undefined; this.error = 'Direct bridge exited.'; }
        resolve();
      }));
      try {
        const { port, route } = await readStartup(child);
        if (child.exitCode !== null || route.systemRoute !== !!this.options.systemRoute) throw unavailable();
        this.bridge = { child, closed, scopeKey, url: new URL(`http://bridge:${token}@127.0.0.1:${port}`), route, signature };
        this.error = null;
      } catch (err) { child.stdin.end(); child.kill(); await closed; throw err; }
    } catch (err) { const safe = safeError(err); this.error = safe.message; throw safe; }
  }
  syncFromConfig() { return this.exclusive(async () => { await this.apply(this.db.state('directBypass')); return this.snapshot(); }); }
  updateConfig(patch: UpdateDirectBypassRequest) {
    return this.exclusive(async () => {
      const config = { ...this.db.state('directBypass'), ...patch };
      this.db.setState('directBypass', config);
      this.selected = null;
      try { await this.apply(config); } catch { /* Preserve the requested policy and expose its startup error in status. */ }
      return this.snapshot();
    });
  }
  async resolvePolicy(url: URL): Promise<DirectPolicy | undefined> {
    if (isLoopbackUrl(url)) return;
    return this.exclusive(async () => {
      const config = this.db.state('directBypass');
      if (!config.enabled) return;
      if (config.mode === 'skip-proxy') return { kind: 'skip-proxy' } as const;
      await this.apply(config);
      const bridge = this.bridge;
      if (!bridge) throw unavailable();
      const authorityGrant = createHmac('sha256', bridge.scopeKey).update(connectAuthority(url)).digest('hex');
      return { kind: 'bridge', proxyUrl: bridge.url, authorityGrant } as const;
    });
  }
  async probe(req: DirectBypassProbeRequest): Promise<DirectBypassProbeResult> {
    const url = new URL(req.url ?? PHUKET_BASE_URL), signal = AbortSignal.timeout(10000), start = performance.now();
    const result: DirectBypassProbeResult = { testedAt: now(), ok: false, statusCode: null, mode: this.db.state('directBypass').mode, bypassUsed: false, route: null, error: null, latencyMs: 0 };
    try {
      const res = await adaptiveFetch(url, { redirect: 'manual', signal }, fetch, async target => {
        const policy = await this.resolvePolicy(target);
        result.bypassUsed = !!policy;
        if (policy?.kind === 'bridge') { result.mode = 'physical-nic'; result.route = this.bridge?.route ?? null; }
        if (policy?.kind === 'skip-proxy') result.mode = 'skip-proxy';
        return policy;
      });
      result.statusCode = res.status; result.ok = res.status < 500;
      await res.body?.cancel();
      if (!result.ok) result.error = `Upstream returned HTTP ${res.status}.`;
    } catch (err) { result.error = err instanceof ApiError && err.code === 'DIRECT_BYPASS_UNAVAILABLE' ? err.message : signal.aborted ? 'Probe timed out.' : 'Connection failed.'; }
    result.latencyMs = elapsed(start); return result;
  }
  close(): Promise<void> {
    if (!this.closing) {
      this.closing = true; this.unregister(); this.queue = this.queue.then(() => this.stopBridge());
    }
    return this.queue;
  }
}
