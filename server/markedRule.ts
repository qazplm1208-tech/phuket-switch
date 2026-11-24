import { conflict } from './common.js';

/** Replace only the delimited span, preserving surrounding text and its newline convention. */
export function markedRule(startMarker: string, endMarker: string, name: string) {
  function read(src: string) {
    const start = src.indexOf(startMarker), end = src.indexOf(endMarker);
    if (start < 0 && end < 0) return null;
    if (start < 0 || end < start || start !== src.lastIndexOf(startMarker) || end !== src.lastIndexOf(endMarker)) throw conflict(`Ambiguous ${name} rule markers; the file was not changed.`);
    return src.slice(start, end + endMarker.length);
  }
  function edit(src: string, block: string | null) {
    const previous = read(src), nl = src.includes('\r\n') ? '\r\n' : '\n';
    if (previous) {
      if (block) return src.replace(previous, () => block.replace(/\r?\n/g, nl));
      const start = src.indexOf(previous), end = start + previous.length;
      return src.slice(0, start) + src.slice(end).replace(/^\r?\n/, '');
    }
    if (!block) return src;
    return src + (src && !src.endsWith('\n') ? nl : '') + block.replace(/\r?\n/g, nl) + nl;
  }
  return { read, edit };
}
