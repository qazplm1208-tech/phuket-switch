import fs from 'node:fs';
import path from 'node:path';
import { isUltraFastGroup, sortModelsNewestFirst } from '../shared/constants.js';
import { googleCliPlan, readGoogleCliState, redactEnvFile } from './geminiConfig.js';
import type { AppType, ConfigDiffPreview, GptFastConfig, LiveCliState, ModelRouteRule, Provider, ProxyStatus, SystemApplyResult } from '../shared/types.js';
import { apps, type SwitchDb } from './db.js';
import { conflict, isRecord, normalizeV1Base, notApplied, now, own, redactRecognizable, secretField, stripV1, stripV1Beta } from './common.js';
import { CLAUDE_DESKTOP_PROFILE_ID, CLAUDE_DESKTOP_PROFILE_NAME, cliPaths, commitFiles, desktopConfigText, jsonText, parseJson, restoreBackup as restoreFiles, textFile, type Plan } from './configFiles.js';
import { codexConfigTier, effectiveSpeedMode, fallbackCodexModels as fallbackModels, fastModel, missingUltraFastMessage, parseVirtualSpeedModel, resolveUltraFastProvider, speedMenuModels } from './fastMode.js';
import { parseToml, redactToml, replaceTomlSubtree, updateTomlFields } from './surgicalToml.js';

const baseInstructions = 'You are Codex, a coding agent. You and the user share the same workspace and collaborate to achieve the user\'s goals.';
type CatalogEntry = Record<string, any>;
type CatalogEntryOptions = { contextWindow?: number; inputModalities?: string[] };
const nativeSpeedTiers = {
  additional_speed_tiers: ['fast', 'ultrafast'],
  service_tiers: [
    { id: 'priority', name: 'Fast', description: '普通分组 Fast 加速（service_tier=priority）' },
    { id: 'ultrafast', name: 'Ultrafast', description: 'UltraFast 极速（自动路由至 Pro500 ultrafast 分组）' },
  ],
  default_service_tier: null,
};
const reasoningLevels = () => ['low', 'medium', 'high'].map(effort => ({ effort, description: effort }));
const catalogEntry = (slug: string, priority: number, opts: CatalogEntryOptions = {}): CatalogEntry => ({
  slug, display_name: slug, description: slug, priority, visibility: 'list', supported_in_api: true, shell_type: 'shell_command',
  default_reasoning_level: 'high', supported_reasoning_levels: reasoningLevels(), base_instructions: baseInstructions,
  supports_reasoning_summaries: true, default_reasoning_summary: 'none', support_verbosity: false,
  truncation_policy: { mode: 'bytes', limit: 10000 }, supports_parallel_tool_calls: false, experimental_supported_tools: [],
  input_modalities: opts.inputModalities ?? ['text', 'image'], context_window: opts.contextWindow ?? 272000,
  max_context_window: opts.contextWindow ?? 272000, effective_context_window_percent: 95,
  supports_image_detail_original: false, supports_search_tool: false, additional_speed_tiers: [], service_tiers: [],
  availability_nux: null, upgrade: null,
});
function normalizeCatalogEntry(entry: unknown, index: number, priority?: number): CatalogEntry {
  const source = isRecord(entry) ? entry : {};
  const fallback = catalogEntry(typeof source.slug === 'string' ? source.slug : typeof source.id === 'string' ? source.id : `model-${index}`, priority ?? index);
  const strings = (value: unknown, defaultValue: string) => typeof value === 'string' ? value : defaultValue;
  const finiteNumber = (value: unknown, defaultValue: number) => typeof value === 'number' && Number.isFinite(value) ? value : defaultValue;
  const stringArray = (value: unknown, defaultValue: string[]) => Array.isArray(value) && value.every(v => typeof v === 'string') ? value : defaultValue;
  const reasoning = Array.isArray(source.supported_reasoning_levels) && source.supported_reasoning_levels.every(isRecord)
    && source.supported_reasoning_levels.every(v => typeof v.effort === 'string' && typeof v.description === 'string')
    ? source.supported_reasoning_levels : fallback.supported_reasoning_levels;
  const truncation = isRecord(source.truncation_policy) && typeof source.truncation_policy.mode === 'string'
    && typeof source.truncation_policy.limit === 'number' && Number.isFinite(source.truncation_policy.limit)
    ? source.truncation_policy : fallback.truncation_policy;
  const tiers = Array.isArray(source.service_tiers) && source.service_tiers.every(isRecord) ? source.service_tiers : fallback.service_tiers;
  return {
    slug: strings(source.slug, fallback.slug), display_name: strings(source.display_name, fallback.display_name),
    description: strings(source.description, fallback.description), priority: priority ?? finiteNumber(source.priority, fallback.priority),
    visibility: strings(source.visibility, fallback.visibility), supported_in_api: typeof source.supported_in_api === 'boolean' ? source.supported_in_api : fallback.supported_in_api,
    shell_type: strings(source.shell_type, fallback.shell_type), default_reasoning_level: strings(source.default_reasoning_level, fallback.default_reasoning_level),
    supported_reasoning_levels: reasoning, base_instructions: strings(source.base_instructions, fallback.base_instructions),
    supports_reasoning_summaries: typeof source.supports_reasoning_summaries === 'boolean' ? source.supports_reasoning_summaries : fallback.supports_reasoning_summaries,
    default_reasoning_summary: strings(source.default_reasoning_summary, fallback.default_reasoning_summary),
    support_verbosity: typeof source.support_verbosity === 'boolean' ? source.support_verbosity : fallback.support_verbosity,
    truncation_policy: truncation, supports_parallel_tool_calls: typeof source.supports_parallel_tool_calls === 'boolean' ? source.supports_parallel_tool_calls : fallback.supports_parallel_tool_calls,
    experimental_supported_tools: stringArray(source.experimental_supported_tools, fallback.experimental_supported_tools),
    input_modalities: stringArray(source.input_modalities, fallback.input_modalities), context_window: finiteNumber(source.context_window, fallback.context_window),
    max_context_window: finiteNumber(source.max_context_window, source.context_window && typeof source.context_window === 'number' ? source.context_window : fallback.max_context_window),
    effective_context_window_percent: finiteNumber(source.effective_context_window_percent, fallback.effective_context_window_percent),
    supports_image_detail_original: typeof source.supports_image_detail_original === 'boolean' ? source.supports_image_detail_original : fallback.supports_image_detail_original,
    supports_search_tool: typeof source.supports_search_tool === 'boolean' ? source.supports_search_tool : fallback.supports_search_tool,
    additional_speed_tiers: stringArray(source.additional_speed_tiers, fallback.additional_speed_tiers), service_tiers: tiers,
    default_service_tier: Object.hasOwn(source, 'default_service_tier') ? source.default_service_tier : null,
    availability_nux: Object.hasOwn(source, 'availability_nux') ? source.availability_nux : fallback.availability_nux,
    upgrade: Object.hasOwn(source, 'upgrade') ? source.upgrade : fallback.upgrade,
  };
}
function readCatalog(file: string): Record<string, any> | null {
  const text = textFile(file);
  if (text === null) return null;
  const doc = parseJson(text);
  if (!Array.isArray(doc.models)) throw conflict('Model catalog has no models array; it was not replaced.');
  return doc;
}
function routeSlugs(routes: ModelRouteRule[]) {
  return [...new Set(routes.filter(r => r.enabled && r.sourceClient === 'codex' && r.sourceModel !== '*' && !parseVirtualSpeedModel(r.sourceModel).forcedMode).map(r => r.sourceModel))];
}
type CatalogOptions = { includeRoutedModels: boolean; includeSpeedVariants: boolean; ultraFastProvider?: Provider | null; previousRouteSlugs: string[] };
function catalog(provider: Provider, fast: GptFastConfig, routes: ModelRouteRule[], { includeRoutedModels, includeSpeedVariants, ultraFastProvider, previousRouteSlugs }: CatalogOptions) {
  const target = cliPaths().catalog, dir = path.dirname(target);
  const documents = [
    readCatalog(target),
    readCatalog(path.join(dir, 'cc-switch-model-catalog.json')),
    readCatalog(path.join(dir, 'model-catalog-6.1-sol.json')),
  ].filter((doc): doc is Record<string, any> => doc !== null);
  const metadata = new Map<string, CatalogEntry>();
  for (const doc of documents) for (const entry of doc.models) {
    if (!isRecord(entry)) continue;
    const slug = typeof entry.slug === 'string' ? entry.slug : '';
    if (slug && !metadata.has(slug)) metadata.set(slug, entry);
  }
  const routed = new Set(routeSlugs(routes));
  const knownRoutes = new Set([...previousRouteSlugs, ...routes.filter(r => r.sourceClient === 'codex').map(r => r.sourceModel)]);
  const providerModels = [provider.model, ...sortModelsNewestFirst(provider.availableModels ?? [])].filter((m): m is string => !!m && !parseVirtualSpeedModel(m).forcedMode);
  const nativeSlugs = providerModels.length ? providerModels : [...metadata.keys()].filter(slug => !knownRoutes.has(slug) && !metadata.get(slug)?.phuket_switch_route).concat(fallbackModels);
  const effectiveFastModels = effectiveSpeedMode(fast) === 'fast' && fast.strategy !== 'tier_only'
    ? nativeSlugs.flatMap(baseModel => Object.hasOwn(fast.fastModelMap, baseModel) ? [fast.fastModelMap[baseModel]] : []) : [];
  const menu = speedMenuModels([...nativeSlugs, ...effectiveFastModels], includeSpeedVariants, ultraFastProvider);
  const models = menu.filter(row => !includeRoutedModels || !routed.has(row.baseModel)).map(({ slug, baseModel, mode }, index) => {
    const priority = index + 1;
    const entry = normalizeCatalogEntry(metadata.get(baseModel) ?? catalogEntry(baseModel, priority), index, priority);
    if (/^(?:gpt-(?!image-)|codex(?:-|$)|o[1-9](?:-|$))/i.test(baseModel)) Object.assign(entry, nativeSpeedTiers);
    if (!mode) return entry;
    return { ...entry, slug, visibility: 'list', supported_in_api: true,
      display_name: `${baseModel} ${mode === 'fast' ? '⚡ Fast' : '⚡⚡ UltraFast'}`,
      description: mode === 'fast' ? '普通分组 Fast 加速（免登录直选）' : 'Pro500 ultrafast 专属极速通道（免登录直选）' };
  });
  const routePriority = Math.max(1000, models.length + 1);
  if (includeRoutedModels) for (const [index, slug] of [...routed].entries()) {
    const entry = normalizeCatalogEntry(metadata.get(slug) ?? catalogEntry(slug, routePriority + index, { contextWindow: 200000 }), models.length, routePriority + index);
    entry.visibility = 'list'; entry.supported_in_api = true;
    if (!Number.isFinite(entry.context_window) || entry.context_window < 200000) entry.context_window = 200000;
    if (!Number.isFinite(entry.max_context_window) || entry.max_context_window < entry.context_window) entry.max_context_window = entry.context_window;
    models.push(entry);
  }
  const base = documents[0] ?? { version: 4 };
  return jsonText({ ...base, models });
}
const virtualWarning = 'GPT Native is a virtual route on the local proxy.';
function desktopActivePath(f: ReturnType<typeof cliPaths>, id: unknown) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(id) || /^(_meta|con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(id)) return f.claudeDesktopProfile;
  return path.join(path.dirname(f.claudeDesktopMeta), `${id}.json`);
}
export function desktopModelNames(p: Provider) {
  const map = p.claudeModelMap;
  return [...new Set([map?.opus, map?.sonnet, map?.haiku, map?.defaultModel, p.model, ...(p.availableModels ?? [])].filter((name): name is string => typeof name === 'string' && !!name.trim()).map(name => name.trim()))];
}
function desktopPlan(f: ReturnType<typeof cliPaths>, p: Provider, url: string, key: string): Plan {
  const meta = parseJson(desktopConfigText(f.claudeDesktopMeta));
  const entries = Array.isArray(meta.entries) ? meta.entries.filter(isRecord).filter(e => typeof e.id === 'string' && e.id && typeof e.name === 'string' && e.name) : [];
  const managed = { ...entries.find(e => e.id === CLAUDE_DESKTOP_PROFILE_ID), id: CLAUDE_DESKTOP_PROFILE_ID, name: CLAUDE_DESKTOP_PROFILE_NAME };
  const nextMeta = { ...meta, entries: [...entries.filter(e => e.id !== managed.id), managed], appliedId: managed.id };
  const existing = desktopConfigText(f.claudeDesktopProfile);
  let base = parseJson(existing);
  const activePath = desktopActivePath(f, meta.appliedId);
  if (existing === null && activePath !== f.claudeDesktopProfile) {
    const previous = desktopConfigText(activePath);
    try { base = parseJson(previous); } catch { /* An invalid foreign profile is left untouched. */ }
  }
  const models = base.inferenceModels;
  const nextProfile = { desktopHome: 'standard', inferenceModelPricingEnabled: true, inferenceModelPricingMultiplier: 1, coworkEgressAllowedHosts: ['*'], builtinBrowserEnabled: true, disableDeploymentModeChooser: true,
    ...base, inferenceProvider: 'gateway', inferenceCredentialKind: 'static', inferenceGatewayAuthScheme: 'bearer', inferenceGatewayBaseUrl: url, inferenceGatewayApiKey: key,
    inferenceModels: Array.isArray(models) && models.length && models.every(m => isRecord(m) && typeof m.name === 'string' && m.name.trim())
      ? models : desktopModelNames(p).slice(0, 8).map(name => ({ name, supports1m: true })) };
  return new Map([[f.claudeDesktopMeta, jsonText(nextMeta)], [f.claudeDesktopProfile, jsonText(nextProfile)]]);
}
function writeCatalogRoutes(db: SwitchDb, includeRoutedModels: boolean): SystemApplyResult {
  const takeover = db.state('proxyTakeover').codex, p = db.current('codex');
  if (includeRoutedModels && !takeover) throw conflict('请先在「本地代理 → 代理与接管」开启 Codex 代理接管，再同步跨协议模型到 Codex 目录。');
  if (includeRoutedModels && !p) throw conflict('Select a Codex provider before syncing the catalog.');
  const routes = db.state('modelRoutes');
  let result: SystemApplyResult = notApplied();
  if (p) {
    const fast = p.codexFastConfig ?? db.state('fastMode'), dedicated = resolveUltraFastProvider(db.providers(), p, fast);
    const upstream = !takeover && effectiveSpeedMode(fast) === 'ultrafast' ? dedicated ?? p : p;
    const content = catalog(upstream, fast, routes, { includeRoutedModels, includeSpeedVariants: takeover && fast.catalogSpeedVariants !== false,
      ultraFastProvider: dedicated, previousRouteSlugs: db.state('codexCatalogRouteSlugs') });
    result = commitFiles(db, 'codex', includeRoutedModels ? 'Sync routed models to Codex catalog' : 'Remove routed models from Codex catalog', new Map([[cliPaths().catalog, content]]));
  }
  db.transaction(() => {
    db.setState('codexIncludeRoutedModels', includeRoutedModels);
    db.setState('codexCatalogRouteSlugs', includeRoutedModels ? routeSlugs(routes) : []);
  });
  return result;
}
export const syncCodexCatalog = (db: SwitchDb) => writeCatalogRoutes(db, true);
export const clearCodexCatalogRoutes = (db: SwitchDb) => writeCatalogRoutes(db, false);
function hasInteractiveAuth(doc: Record<string, any>) {
  return doc.auth_mode === 'chatgpt' || doc.auth_mode === 'personal_access_token' || isRecord(doc.tokens) || typeof doc.access_token === 'string';
}
export function restoreBackup(db: SwitchDb, id: string, directProvider?: Provider | null): SystemApplyResult {
  const authPath = cliPaths().auth;
  if (db.backups(id)[0]?.files.includes(authPath)) {
    const text = textFile(authPath);
    let auth: Record<string, any> | undefined;
    try { auth = parseJson(text); } catch { /* Malformed auth can still be repaired from a backup. */ }
    if (auth && hasInteractiveAuth(auth)) {
      // Desktop may have signed in *after* an API-key-only takeover snapshot was created.
      if (directProvider?.appType === 'codex') return { ...applyProvider(db, directProvider), warnings: ['已保留当前 Codex 登录状态，并重新应用直连配置。'] };
      throw conflict('备份包含 auth.json。为保留当前 Codex 登录状态，未恢复此备份。');
    }
  }
  return restoreFiles(db, id);
}
export function providerPlan(p: Provider, fast: GptFastConfig, proxyRoot?: string, routes: ModelRouteRule[] = [], previousRouteSlugs: string[] = [], ultraFastProvider?: Provider | null, includeRoutedModels = false, agyBindings: Record<string, string> = {}): Plan {
  const f = cliPaths();
  const directUltra = p.appType === 'codex' && !proxyRoot && effectiveSpeedMode(fast) === 'ultrafast';
  const upstream = directUltra ? ultraFastProvider ?? (isUltraFastGroup(p) ? p : null) : p;
  if (!upstream) throw conflict(missingUltraFastMessage);
  const url = proxyRoot || upstream.baseUrl, key = proxyRoot ? 'phuket-switch-local' : upstream.apiKey;
  if (p.appType === 'claude') {
    const settings = parseJson(textFile(f.claude));
    if (settings.env !== undefined && !isRecord(settings.env)) throw conflict('Claude env is not an object.');
    const env = { ...settings.env, ANTHROPIC_BASE_URL: stripV1(url), ANTHROPIC_AUTH_TOKEN: key };
    const map = p.claudeModelMap;
    for (const [k, v] of Object.entries({ ANTHROPIC_MODEL: map?.defaultModel, ANTHROPIC_DEFAULT_OPUS_MODEL: map?.opus, ANTHROPIC_DEFAULT_SONNET_MODEL: map?.sonnet, ANTHROPIC_DEFAULT_HAIKU_MODEL: map?.haiku })) if (v) env[k] = v;
    return new Map([[f.claude, jsonText({ ...settings, env })]]);
  }
  if (p.appType === 'claude-desktop') return desktopPlan(f, p, proxyRoot ? `${stripV1(proxyRoot)}/claude-desktop` : stripV1(upstream.baseUrl), key);
  if (p.appType === 'gemini' || p.appType === 'antigravity') return googleCliPlan(p, proxyRoot, agyBindings);
  if (p.appType !== 'codex') return new Map();
  const current = textFile(f.codex) ?? '', existing = parseToml(current);
  const observedModel = typeof existing.model === 'string' ? existing.model : '';
  const preferred = upstream === p || upstream.availableModels?.includes(p.model ?? '') ? p.model : upstream.model;
  const baseModel = preferred || Object.entries(fast.fastModelMap).find(([, suffix]) => suffix === observedModel)?.[0] || observedModel || fallbackModels[0];
  const selected = fastModel(baseModel, fast);
  const model = proxyRoot && fast.catalogSpeedVariants !== false ? selected : parseVirtualSpeedModel(selected).baseModel;
  const top = updateTomlFields(current, [], { service_tier: codexConfigTier(fast), model_provider: 'custom', model, model_catalog_json: 'phuket-switch-model-catalog.json' });
  const config = replaceTomlSubtree(top, ['model_providers', 'custom'], { name: upstream.name, base_url: normalizeV1Base(url), wire_api: 'responses', requires_openai_auth: false, experimental_bearer_token: key });
  const existingAuth = parseJson(textFile(f.auth));
  const content = catalog(upstream, fast, routes, { includeRoutedModels: !!proxyRoot && includeRoutedModels, includeSpeedVariants: !!proxyRoot && fast.catalogSpeedVariants !== false, ultraFastProvider, previousRouteSlugs });
  const plan: Plan = new Map([[f.codex, config], [f.catalog, content]]);
  // The custom bearer authenticates inference independently of the user's Desktop session.
  if (!hasInteractiveAuth(existingAuth)) plan.set(f.auth, jsonText({ ...existingAuth, OPENAI_API_KEY: key }));
  return plan;
}
function planForProvider(db: SwitchDb, p: Provider, fast: GptFastConfig, proxyRoot?: string) {
  const ultraFastProvider = p.appType === 'codex' ? resolveUltraFastProvider(db.providers(), p, fast) : undefined;
  return providerPlan(p, fast, proxyRoot, db.state('modelRoutes'), db.state('codexCatalogRouteSlugs'), ultraFastProvider, db.state('codexIncludeRoutedModels'), p.appType === 'antigravity' ? db.state('antigravityModelBindings') : {});
}
export function applyProvider(db: SwitchDb, p: Provider, options: { fast?: GptFastConfig; proxyRoot?: string; takeover?: boolean } = {}): SystemApplyResult {
  const plan = planForProvider(db, p, options.fast ?? p.codexFastConfig ?? db.state('fastMode'), options.proxyRoot);
  if (!plan.size) return { ...notApplied(), warnings: [virtualWarning] };
  const result = commitFiles(db, p.appType, options.takeover ? 'Enable proxy takeover' : 'Apply provider configuration', plan, options.takeover);
  if (p.appType === 'codex') db.setState('codexCatalogRouteSlugs', options.proxyRoot && db.state('codexIncludeRoutedModels') ? routeSlugs(db.state('modelRoutes')) : []);
  return result;
}
function redactJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, secretField(k) || /headers/i.test(k) ? '[REDACTED]' : redactJson(v)]));
}
export function previewProviderDiff(db: SwitchDb, p: Provider, proxyRoot?: string): ConfigDiffPreview {
  const plan = planForProvider(db, p, p.codexFastConfig ?? db.state('fastMode'), proxyRoot);
  const session = db.state('phuketSession');
  const secrets = [...db.providers().map(p => p.apiKey), session?.token, session?.refreshToken].filter((v): v is string => !!v);
  function safe(file: string, text: string | null) {
    if (text === null) return null;
    let s = file.endsWith('.toml') ? redactToml(text) : path.basename(file) === '.env' ? redactEnvFile(text) : jsonText(redactJson(parseJson(text)));
    for (const value of secrets) s = s.replaceAll(value, '[REDACTED]');
    return redactRecognizable(s);
  }
  return { appType: p.appType, providerId: p.id, files: [...plan].map(([file, after]) => ({ path: file, before: safe(file, textFile(file)), after: safe(file, after as string) })), warnings: plan.size ? [] : [virtualWarning] };
}
export function getLiveCliStates(providers: Provider[], proxy?: ProxyStatus): LiveCliState[] {
  const f = cliPaths();
  return apps.map(appType => {
    const paths = { gemini: [f.geminiEnv, f.geminiSettings], antigravity: [f.antigravitySettings], claude: [f.claude], codex: [f.codex, f.auth], 'claude-desktop': [f.claudeDesktopMeta, f.claudeDesktopProfile], 'gpt-native': [] }[appType];
    const current = providers.find(p => p.appType === appType && p.isCurrent);
    const s: LiveCliState = { appType, detected: paths.some(file => fs.existsSync(file)), configPaths: paths, providerId: null, baseUrl: null, model: null, checkedAt: now(), warnings: [] };
    try {
      let key: string | undefined;
      if (appType === 'gpt-native') {
        s.detected = !!current || !!proxy?.running; s.providerId = current?.id ?? null; s.model = current?.model ?? null;
        s.baseUrl = proxy?.running ? `${proxy.baseUrl}/v1` : current?.baseUrl ?? null; return s;
      }
      if (appType === 'gemini' || appType === 'antigravity') {
        const state = readGoogleCliState(appType, providers);
        s.baseUrl = state.base ?? null; s.model = state.model ?? null; key = state.key;
        if (state.warning) s.warnings.push(state.warning);
      } else if (appType === 'claude-desktop') {
        const meta = parseJson(desktopConfigText(f.claudeDesktopMeta)), active = desktopActivePath(f, meta.appliedId);
        s.configPaths = [f.claudeDesktopMeta, active]; s.detected = s.configPaths.some(file => fs.existsSync(file));
        const profile = parseJson(desktopConfigText(active)), first = Array.isArray(profile.inferenceModels) ? own(profile.inferenceModels[0]) : {};
        s.baseUrl = profile.inferenceGatewayBaseUrl; key = profile.inferenceGatewayApiKey; s.model = first.labelOverride || first.name || null;
      } else if (appType === 'claude') {
        const env = own(parseJson(textFile(f.claude)).env); s.model = env.ANTHROPIC_MODEL ?? null; s.baseUrl = env.ANTHROPIC_BASE_URL ?? null; key = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY;
      } else {
        const t = parseToml(textFile(f.codex) ?? ''), custom = own(own(t.model_providers)[String(t.model_provider || 'custom')]);
        s.baseUrl = custom.base_url ?? null; s.model = typeof t.model === 'string' ? t.model : null;
        key = custom.experimental_bearer_token || parseJson(textFile(f.auth)).OPENAI_API_KEY;
        if (current?.codexFastConfig && t.service_tier !== codexConfigTier(current.codexFastConfig)) s.warnings.push('The live service tier differs from the provider preference.');
      }
      if (typeof s.baseUrl !== 'string') s.baseUrl = null;
      if (typeof s.model !== 'string') s.model = null;
      if (s.baseUrl) {
        const desktop = appType === 'claude-desktop', google = appType === 'gemini' || appType === 'antigravity';
        const normalize = google ? stripV1Beta : stripV1;
        const managed = proxy?.takeover[appType] && normalize(s.baseUrl) === `http://${proxy.settings.host}:${proxy.settings.port}${desktop || google ? `/${appType}` : ''}`;
        const endpoint = desktop || google ? URL.parse(s.baseUrl) : null;
        const matches = providers.filter(p => p.appType === appType && normalize(p.baseUrl) === normalize(s.baseUrl!) && (!key || key === p.apiKey));
        if (managed && (!(desktop || google) || proxy.running)) s.providerId = current?.id ?? null;
        else if (endpoint && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) && (desktop || managed || !matches.length)) {
          const name = desktop ? 'Claude Desktop' : appType === 'gemini' ? 'Gemini CLI' : 'Antigravity CLI';
          s.warnings.push(`${name} 指向未接管或已停止的本地代理（${endpoint.host}）。请关闭接管后在「供应商」点击「同步写入」使用直连，或在「本地代理」启用 ${name} 接管并启动代理，然后重启 ${name}。`);
        } else s.providerId = (matches.find(p => p.isCurrent) ?? matches[0])?.id ?? null;
      }
    } catch { s.warnings.push('Unable to read the live configuration.'); }
    return s;
  });
}
