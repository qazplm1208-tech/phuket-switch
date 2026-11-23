import { parseEnv } from 'node:util';
import { providerModelNames } from '../shared/constants.js';
import type { Provider } from '../shared/types.js';
import { conflict, httpBase, isRecord, redactRecognizable, secretField, stripV1, stripV1Beta } from './common.js';
import { cliPaths, jsonText, parseJson, textFile, type Plan } from './configFiles.js';
import { readAgyEnv } from './agyEnvironment.js';

export const parseEnvFile = (text: string | null) => parseEnv(text ?? '');
// Match whole assignments (including quoted multiline values) without consuming their line endings.
const assignment = /^([\t \uFEFF]*(?:export[\t ]+)?([\w.-]+)[\t ]*=[\t ]*)("(?:\\.|[^"\\])*"|'[^']*'|[^#\r\n]*?)([\t ]*(?:#[^\r\n]*)?)(?=\r?$)/gm;
function envValue(value: string) {
  if (!/[\r\n\0]/.test(value)) {
    if (!/[\s#'"`]/.test(value)) return value;
    if (!value.includes("'")) return `'${value}'`;
    if (!value.includes('"')) return `"${value}"`;
  }
  throw conflict('配置值不能安全地写入 Gemini .env。');
}
export function updateEnvFile(text: string, values: Record<string, string>) {
  const seen = new Set<string>(), eol = text.includes('\r\n') ? '\r\n' : '\n';
  let result = text.replace(assignment, (line, prefix, key, _old, comment) => {
    if (!Object.hasOwn(values, key)) return line;
    seen.add(key); return prefix + envValue(values[key]) + comment;
  });
  for (const [key, value] of Object.entries(values)) if (!seen.has(key)) {
    if (result && !result.endsWith('\n')) result += eol;
    result += `${key}=${envValue(value)}${eol}`;
  }
  return result;
}
export function redactEnvFile(text: string) {
  let safe = text.replace(assignment, (line, prefix, key, _value, comment) => secretField(key) ? `${prefix}[REDACTED]${comment}` : line);
  for (const [k, v] of Object.entries(parseEnvFile(text))) if (secretField(k) && v) safe = safe.replaceAll(v, '[REDACTED]');
  return redactRecognizable(safe);
}
function section(doc: Record<string, any>, key: string): Record<string, any> {
  if (doc[key] === undefined) return {};
  if (!isRecord(doc[key])) throw conflict(`Invalid ${key} configuration; no changes were made.`);
  return doc[key];
}
export function googleCliPlan(p: Provider, proxyRoot?: string, previous: Record<string, string> = {}): Plan {
  const f = cliPaths(), base = proxyRoot ? `${stripV1(proxyRoot)}/${p.appType}` : stripV1Beta(p.baseUrl);
  const env = { GOOGLE_GEMINI_BASE_URL: base, GEMINI_API_KEY: proxyRoot ? 'phuket-switch-local' : p.apiKey };
  if (p.appType === 'gemini') {
    const doc = parseJson(textFile(f.geminiSettings)), security = section(doc, 'security'), auth = section(security, 'auth');
    return new Map([[f.geminiEnv, updateEnvFile(textFile(f.geminiEnv) ?? '', { ...env, ...(p.model ? { GEMINI_MODEL: p.model } : {}) })],
      [f.geminiSettings, jsonText({ ...doc, security: { ...security, auth: { ...auth, selectedType: 'gemini-api-key' } } })]]);
  }
  const doc = parseJson(textFile(f.antigravitySettings)), config = section(doc, 'customModelsConfig');
  const names = providerModelNames(p).filter(name => !/image/i.test(name)).slice(0, 24);
  const models = names.map(label => ({ label, modelName: `gemini-api://${base.replace(/^https?:\/\//i, '')}/v1beta/models/${encodeURIComponent(label)}` }));
  const uris = new Set(models.map(m => m.modelName));
  const kept = new Map(Object.entries(section(config, 'customModels')).filter(([id, model]) =>
    !isRecord(model) || !(uris.has(model.modelName) || (Object.hasOwn(previous, id) && previous[id] === model.modelName))));
  const managed = new Map<string, typeof models[number]>();
  for (const model of models) {
    let id = model.label;
    while (kept.has(id) || managed.has(id)) id = `phuket-switch:${id}`;
    managed.set(id, model);
  }
  const customModels = Object.fromEntries([...managed, ...kept]);
  const next = { ...doc, modelProvider: 'gemini', ...(p.model ? { model: p.model } : {}), customModelsConfig: { ...config, customModels } };
  const plan: Plan = new Map([[f.antigravitySettings, jsonText(next)]]);
  plan.antigravity = { bindings: Object.fromEntries([...managed].map(([k, m]) => [k, m.modelName])), env };
  return plan;
}
export function readGoogleCliState(app: 'gemini' | 'antigravity', providers: Provider[]) {
  const f = cliPaths();
  if (app === 'gemini') {
    const env = parseEnvFile(textFile(f.geminiEnv));
    const mode = parseJson(textFile(f.geminiSettings)).security?.auth?.selectedType;
    return { base: env.GOOGLE_GEMINI_BASE_URL, key: env.GEMINI_API_KEY, model: env.GEMINI_MODEL,
      warning: mode && mode !== 'gemini-api-key' ? 'Gemini CLI 未选择 API 密钥认证，请同步写入配置。' : undefined };
  }
  const doc = parseJson(textFile(f.antigravitySettings));
  if (doc.modelProvider !== 'gemini') return { base: null, model: null, key: undefined };
  const models = Object.values(section(section(doc, 'customModelsConfig'), 'customModels')).filter(isRecord);
  const selected = models.find(m => m.label === doc.model && typeof m.modelName === 'string' && m.modelName.startsWith('gemini-api://'))
    ?? models.find(m => typeof m.modelName === 'string' && m.modelName.startsWith('gemini-api://'));
  const hostPath = /^gemini-api:\/\/(.+)\/v1beta\/models\/[^/]+$/.exec(selected?.modelName ?? '')?.[1];
  const env = readAgyEnv(true);
  // The URI omits the scheme. Prefer a matching saved endpoint over guessing HTTP vs HTTPS.
  const saved = providers.find(p => p.appType === app && stripV1Beta(p.baseUrl).replace(/^https?:\/\//i, '') === hostPath);
  const inferred = hostPath && (saved ? stripV1Beta(saved.baseUrl) : `${/^(?:localhost|127\.0\.0\.1|\[::1\])(?=[:/]|$)/i.test(hostPath) ? 'http' : 'https'}://${hostPath}`);
  const base = env?.GOOGLE_GEMINI_BASE_URL || inferred;
  return { base: base && httpBase(base) ? stripV1Beta(base) : null, key: env?.GEMINI_API_KEY ?? undefined, model: doc.model ?? selected?.label };
}
