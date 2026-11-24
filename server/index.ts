import { DEFAULT_PROXY_SETTINGS, DEFAULT_SERVER_PORT } from '../shared/constants.js';
import { createManagementApp, createRuntime } from './app.js';

const runtime = createRuntime(), host = DEFAULT_PROXY_SETTINGS.host;
const port = Number(process.env.PHUKET_SWITCH_PORT || DEFAULT_SERVER_PORT);
const server = createManagementApp(undefined, runtime).listen(port, host, () => {
  console.log(`Phuket Switch: http://${host}:${port}`);
  const direct = runtime.db.state('directBypass');
  if (direct.enabled && direct.mode === 'physical-nic') void runtime.directBypass.syncFromConfig().catch(() => console.error('Could not resume the physical network route. Check the direct bypass settings.'));
  // Persistent takeover must still work after a workstation restart.
  if (Object.values(runtime.db.state('proxyTakeover')).some(Boolean)) void runtime.proxy.start().catch(() => console.error('Could not resume the local proxy. Check its port in settings.'));
});
let closing = false;
function shutdown() {
  if (closing) return; closing = true;
  const deadline = setTimeout(() => { server.closeAllConnections(); process.exit(1); }, 15000); deadline.unref();
  server.close(async () => { try { await runtime.close(); } catch { process.exitCode = 1; } finally { clearTimeout(deadline); } });
}
server.once('error', () => { console.error('Could not bind the management listener. Check its port.'); process.exitCode = 1; shutdown(); });
process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
