import { resolve } from 'node:path';

export function bundledDirectFile(name: 'direct_bridge.py' | 'direct_dns.py' | 'direct_net.py') {
  return resolve(import.meta.dirname, import.meta.filename.endsWith('.ts') ? '..' : '../..', 'direct', name);
}
