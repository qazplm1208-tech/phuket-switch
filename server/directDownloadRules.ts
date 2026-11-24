import type { DirectBypassConfig, DirectDownloadConfig } from '../shared/types.js';
import { bad } from './common.js';
import { markedRule } from './markedRule.js';

export const DIRECT_DOWNLOAD_START = '<!-- PHUKET_SWITCH_DIRECT_DOWNLOAD_START -->';
export const DIRECT_DOWNLOAD_END = '<!-- PHUKET_SWITCH_DIRECT_DOWNLOAD_END -->';
export const { read: directDownloadBlock, edit: editDirectDownloadBlock } = markedRule(DIRECT_DOWNLOAD_START, DIRECT_DOWNLOAD_END, 'direct download');

export type DownloadRoute = Pick<DirectBypassConfig, 'mode' | 'interfaceName' | 'dnsServers'>;
export function effectiveDownloadRoute(config: DirectDownloadConfig, bypass: DirectBypassConfig): DownloadRoute {
  if (config.mode !== 'follow-bypass') return { mode: config.mode, interfaceName: config.interfaceName, dnsServers: config.dnsServers };
  return bypass.enabled ? bypass : { mode: 'skip-proxy', interfaceName: '', dnsServers: [] };
}
export function downloadRouteArgs(route: DownloadRoute) {
  return [...(route.mode === 'skip-proxy' ? ['--system-route'] : ['--physical-nic', ...(route.interfaceName ? ['--interface='+route.interfaceName] : [])]),
    ...(route.dnsServers.length ? ['--dns', route.dnsServers.join(',')] : [])];
}

// This command is user-facing Markdown. The probe passes an argv array directly, never a shell string.
function literal(s: string) {
  if (/[\x00-\x1f\x7f]/.test(s)) throw bad('Cannot render a control character in a command.');
  if (process.platform === 'win32') return '"'+s.replace(/["`$\u2018-\u201e]/g, c => '`'+c)+'"';
  return '"'+s.replace(/["`$\\]/g, c => '\\'+c)+'"';
}
export function renderDirectDownloadRule(config: DirectDownloadConfig, paths: { script: string }, effectiveBypass: DownloadRoute) {
  const args = [...downloadRouteArgs(effectiveBypass), '-c', String(config.connections), '--retries', String(config.retries),
    ...(config.maxRate ? ['--max-rate', config.maxRate] : []), ...(config.resume ? [] : ['--no-resume'])];
  const flags = args.map(a => a.startsWith('--interface=') ? '--interface='+literal(a.slice('--interface='.length)) : a).join(' ');
  return [DIRECT_DOWNLOAD_START, '## File downloads', '',
    'For requested HTTP(S) files, archives and models, use the Phuket Switch downloader instead of curl, wget or Invoke-WebRequest.',
    effectiveBypass.mode === 'physical-nic' ? 'Bind to the Windows physical NIC to bypass app proxies and VPN/TUN routes. If unavailable, report the error.'
      : 'Use the system route without app proxies. OS routing, including VPN/TUN, still applies.', '',
    'Keep the configured flags. Replace URL and the output directory with the actual values:',
    '```'+(process.platform === 'win32' ? 'powershell' : 'sh'),
    `python -u ${literal(paths.script)} ${flags} -d "downloads" --json "URL"`, '```', '',
    '- Inspect first: `--info --json` (no payload file).',
    '- Resume is on by default; `--no-resume` restarts. `-c N` sets parallel HTTP connections.',
    '- Batch: `-i urls.txt -j 3 -d "downloads"` (one URL per line).',
    '- Verify a known digest: `--sha256 HEX`. Unpack an archive with `--extract`.',
    ...(config.enableTorrent ? ['- For a local `.torrent` file or a quoted `magnet:` URI use the same downloader and `-d "downloads"`.',
      '- List torrent files with `--bt-info`; download selected indices/globs with `--bt-select "0,*.bin"`.'] : []), '',
    'Check the exit status and JSON result before reporting a saved path.',
    ...(config.customInstructions?.trim() ? ['', config.customInstructions.trim()] : []), DIRECT_DOWNLOAD_END].join('\n');
}
