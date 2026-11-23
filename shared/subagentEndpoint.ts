import type { SubagentProtocol } from './types.js';

export function parseSubagentBase(value: string) {
  if (/[\s\\?#\x00-\x1f\x7f]/.test(value)) return null;
  const parts = /^(https?):\/\/([^/@]+)(\/.*)?$/i.exec(value);
  if (!parts) return null;
  try {
    // URL validates the host and port; keep the original authority and path for parity with Python's urlsplit.
    const url = new URL(value);
    return { origin: url.origin, authority: `${url.protocol}//${parts[2]}`, path: parts[3] ?? '' };
  } catch { return null; }
}

export function subagentApiRoot(base: NonNullable<ReturnType<typeof parseSubagentBase>>, protocol: SubagentProtocol) {
  const path = base.path.replace(/\/+$/, '');
  if (protocol === 'gemini-native') return base.authority + path.replace(/\/v1(?:beta)?$/i, '') + '/v1beta';
  const prefix = path.replace(/\/(?:responses|chat\/completions|messages)$/i, '');
  return base.authority + prefix + (/\/v\d+(?:alpha\d*|beta\d*)?$/i.test(prefix) ? '' : '/v1');
}
