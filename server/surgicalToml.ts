import TOML from '@iarna/toml';
import { conflict, secretField } from './common.js';

export function parseToml(text: string) {
  try { return TOML.parse(text.replace(/^\uFEFF/, '')); }
  catch { throw conflict('Invalid or unsupported TOML; the configuration was not changed.'); }
}
const quoteKey = (k: string) => /^[\w-]+$/.test(k) ? k : JSON.stringify(k);
const same = (a: string[], b: string[]) => a.length === b.length && prefix(a, b);
const prefix = (a: string[], b: string[]) => b.every((k, i) => a[i] === k);
const keyParts = (s: string) => (s.match(/"(?:\\.|[^"\\])*"|'[^']*'|[\w-]+/g) ?? []).map(k => /^['"]/.test(k) ? String(parseToml(`v=${k}`).v) : k);
type Span = { start: number; end: number; path: string[]; header: boolean; value: number; valueEnd: number };
type Edit = { start: number; end: number; text: string };
function apply(text: string, edits: Edit[]) {
  for (const e of edits.sort((a, b) => b.start - a.start || b.end - a.end)) text = text.slice(0, e.start) + e.text + text.slice(e.end);
  parseToml(text); return text;
}
// Locate complete statements, not lines: arrays and triple-quoted strings may contain
// comments, equals signs and even lines indistinguishable from table headers.
function spans(text: string): Span[] {
  parseToml(text);
  const result: Span[] = []; let section: string[] = [];
  for (let start = text.charCodeAt(0) === 0xfeff ? 1 : 0; start < text.length;) {
    let i = start, depth = 0, eq = -1, last = start, quote = '', multi = false;
    while (i < text.length) {
      const c = text[i++];
      if (quote) {
        if (c === '\\' && quote === '"') { i = Math.min(i + 1, text.length); }
        else if (c === quote && (!multi || text.slice(i, i + 2) === quote.repeat(2))) {
          if (multi) { i += 2; for (let extra = 0; extra < 2 && text[i] === quote; extra++) i++; }
          quote = ''; multi = false;
        }
        last = i; continue;
      }
      if (c === '#') { while (i < text.length && text[i] !== '\n') i++; continue; }
      if (c === '\n' && !depth) break;
      if (/\s/.test(c)) continue;
      if (c === '"' || c === "'") { quote = c; multi = text.slice(i, i + 2) === c.repeat(2); if (multi) i += 2; }
      else if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') depth--;
      else if (c === '=' && eq === -1 && !depth) eq = i - 1;
      last = i;
    }
    const src = text.slice(start, last).trim();
    if (src.startsWith('[')) {
      const n = src.startsWith('[[') ? 2 : 1; section = keyParts(src.slice(n, -n));
      result.push({ start, end: i, path: section, header: true, value: -1, valueEnd: last });
    } else if (eq !== -1) {
      let value = eq + 1; while (/[ \t]/.test(text[value] || '\n')) value++;
      result.push({ start, end: i, path: [...section, ...keyParts(text.slice(start, eq))], header: false, value, valueEnd: last });
    }
    start = i;
  }
  return result;
}
const eol = (s: string) => s.includes('\r\n') ? '\r\n' : '\n';
function insertion(text: string, at: number, lines: string): Edit {
  const nl = eol(text);
  return { start: at, end: at, text: (at && !/[\n\uFEFF]/.test(text[at - 1]) ? nl : '') + lines + nl };
}
export function updateTomlFields(text: string, table: string[], fields: Record<string, string | boolean>): string {
  const all = spans(text), edits: Edit[] = [], add: string[] = [];
  for (const [key, val] of Object.entries(fields)) {
    const path = [...table, key], found = all.find(s => !s.header && same(s.path, path));
    const literal = typeof val === 'string' ? JSON.stringify(val) : String(val);
    if (found) edits.push({ start: found.value, end: found.valueEnd, text: literal });
    else add.push(`${quoteKey(key)} = ${literal}`);
  }
  if (add.length) {
    const head = all.find(s => s.header && same(s.path, table));
    const at = table.length && !head ? text.length : all.find(s => s.header && s.start >= (head?.end ?? 0))?.start ?? text.length;
    if (table.length && !head) add.unshift(`[${table.map(quoteKey).join('.')}]`);
    edits.push(insertion(text, at, add.join(eol(text))));
  }
  return apply(text, edits);
}
// MCP owns a complete subtree (including env/http_headers subtables), not adjacent entries.
export function replaceTomlSubtree(text: string, path: string[], replacement: Record<string, any> | null) {
  const items = spans(text).filter(s => prefix(s.path, path));
  const edits = items.map(s => ({ start: s.start, end: s.end, text: '' }));
  if (replacement) {
    const tree = path.reduceRight<Record<string, any>>((v, k) => ({ [k]: v }), replacement);
    const block = TOML.stringify(tree).trimEnd().replace(/\r?\n/g, eol(text));
    // A dotted root assignment has no header. Inserting a header there would
    // reparent subsequent keys; append in that case. Keep normal tables in place.
    const at = items[0]?.header && same(items[0].path, path) ? items[0].start : text.length;
    edits.push(insertion(text, at, block));
  }
  const out = apply(text, edits);
  const node = path.reduce<any>((v, k) => v?.[k], parseToml(out));
  if ((replacement === null) !== (node === undefined)) throw conflict('Cannot safely edit this inline TOML table.');
  return out;
}
export function redactToml(text: string) {
  const edits: Edit[] = [];
  for (const s of spans(text)) {
    if (s.header) continue;
    const value = text.slice(s.value, s.valueEnd);
    if (same(s.path.slice(0, -1), ['mcp_servers', 'gpt-astra-subagent', 'env']) && ['ASTRA_MAX_CONTEXT_TOKENS', 'ASTRA_COMPACT_TRIGGER_TOKENS'].includes(s.path.at(-1)!) && /^"\d{1,7}"$/.test(value)) continue;
    // Inline tables may contain arbitrary credentials, so mask the entire value.
    if (s.path.some(secretField) || /[{}]/.test(value) || /(?:token|secret|api.key|password|bearer)/i.test(value)) edits.push({ start: s.value, end: s.valueEnd, text: '"[REDACTED]"' });
  }
  return apply(text, edits);
}
