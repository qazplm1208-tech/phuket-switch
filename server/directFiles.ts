import { resolve } from 'node:path';
import { z } from 'zod';

export const routeInfo = z.object({ name: z.string(), description: z.string(), index: z.int().nullable(), ipv4: z.string().nullable(), ipv6: z.string().nullable(),
  gateway: z.string().nullable(), dnsServers: z.array(z.string()), metric: z.int().nullable(), systemRoute: z.boolean() });
export function childEnv(): NodeJS.ProcessEnv {
  const keys = ['SystemRoot', 'WINDIR', 'PATH', 'ComSpec', 'TEMP', 'TMP', 'SystemDrive', 'PSModulePath'];
  return Object.fromEntries(keys.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]));
}

export function bundledDirectFile(name: 'direct_bridge.py' | 'direct_download.py' | 'direct_torrent.py' | 'direct_dns.py' | 'direct_net.py') {
  return resolve(import.meta.dirname, import.meta.filename.endsWith('.ts') ? '..' : '../..', 'direct', name);
}
