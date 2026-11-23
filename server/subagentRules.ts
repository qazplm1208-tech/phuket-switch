import { conflict } from './common.js';

export const SUBAGENT_START = '<!-- PHUKET_SWITCH_SUBAGENT_START -->';
export const SUBAGENT_END = '<!-- PHUKET_SWITCH_SUBAGENT_END -->';
export function subagentBlock(src: string) {
  const start = src.indexOf(SUBAGENT_START), end = src.indexOf(SUBAGENT_END);
  if (start < 0 && end < 0) return null;
  if (start < 0 || end < start || start !== src.lastIndexOf(SUBAGENT_START) || end !== src.lastIndexOf(SUBAGENT_END)) throw conflict('Ambiguous subagent rule markers; the file was not changed.');
  return src.slice(start, end + SUBAGENT_END.length);
}
export function editSubagentBlock(src: string, block: string | null) {
  const previous = subagentBlock(src);
  const nl = src.includes('\r\n') ? '\r\n' : '\n';
  if (previous) {
    if (block) return src.replace(previous, () => block.replace(/\r?\n/g, nl));
    const start = src.indexOf(previous), end = start + previous.length;
    return src.slice(0, start) + src.slice(end).replace(/^\r?\n/, '');
  }
  if (!block) return src;
  return src + (src && !src.endsWith('\n') ? nl : '') + block.replace(/\r?\n/g, nl) + nl;
}
