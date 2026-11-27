import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import express from 'express';
import type { ZodType } from 'zod';
import { ZodError } from 'zod';
import { canCreateGroupKey, allowedGroupModels, isOnlyAstraGroup, isUltraFastGroup, MODEL_SLUG, providerModelNames, buildSuggestedClaudeMap, classifyPhuketGroup, defaultBaseUrlForApp, protocolForApp, pickRecommendedModel, PHUKET_BASE_URL, PHUKET_GPT_BASE_URL } from '../shared/constants.js';
import type { ApiContract, ApiErrorResponse, AppType, GptFastConfig, PhuketAuthStatus, PhuketGroup, Provider, SetupUltraFastRequest, UpdateProviderRequest } from '../shared/types.js';
import { effectiveSpeedMode, fastTier } from './fastMode.js';
import { ApiError, bad, conflict, loopbackRequest, notApplied, now } from './common.js';
import { apps, SwitchDb, toProviderView } from './db.js';
import { applyProvider, clearCodexCatalogRoutes, getLiveCliStates, previewProviderDiff, restoreBackup, syncCodexCatalog } from './configSync.js';
import { PhuketClient } from './phuketClient.js';
import { DirectBypassManager, type DirectBypassOptions } from './directBypass.js';
import { ProxyServer } from './proxyServer.js';
import { runChatTest, runLocalProbe, runSpeedCompare } from './speedLab.js';
import { applyPrompt, deleteMcp, listMcp, listSkills, upsertMcp } from './extensions.js';
import { applyDirectDownload, getDirectDownloadStatus, previewDirectDownload, removeDirectDownload, testDirectDownload } from './directDownloadManager.js';
import { applySubagent, getSubagentStatus, previewSubagent, removeSubagent, testSubagent } from './subagentManager.js';
import { applyImagePrompt, getImagePromptStatus, removeImagePrompt } from './imagePrompt.js';
import { detectCcSwitch, importCcSwitch } from './ccSwitchImport.js';
import { diagnosticKey, runConnectionCheck } from './diagnostics.js';
import * as v from './validation.js';

type DedicatedSetupRequest = Pick<SetupUltraFastRequest, 'apiKey' | 'phuketKeyId' | 'autoCreatePhuketKey' | 'groupId'>;
const dedicatedGroups = {
  ultrafast: { id: 153, label: 'UltraFast', name: 'Pro500 ultrafast', match: isUltraFastGroup, binding: 'ultraFastProviderId', keyName: 'phuket-switch-ultrafast' },
  astra: { id: 155, label: 'Only astra', name: 'Only astra', match: isOnlyAstraGroup, binding: 'astraOnlyProviderId', keyName: 'phuket-switch-only-astra' },
} as const;
type DedicatedGroup = (typeof dedicatedGroups)[keyof typeof dedicatedGroups];

export function createRuntime(options: { db?: SwitchDb; fetch?: typeof fetch; phuketBaseUrl?: string; directBypass?: DirectBypassOptions } = {}) {
  const db = options.db ?? new SwitchDb(), proxy = new ProxyServer(db), phuket = new PhuketClient(db, options.fetch, options.phuketBaseUrl);
  const directBypass = new DirectBypassManager(db, options.directBypass);
  return { db, proxy, phuket, directBypass, fetch: options.fetch ?? fetch, close: async () => {
    try { await proxy.stop(); } finally { await directBypass.close(); db.close(); }
  } };
}
const defaultWebRoot = resolve(import.meta.dirname, import.meta.filename.endsWith('.ts') ? '../dist/web' : '../web');

export function createManagementApp(webRoot = defaultWebRoot, runtime = createRuntime()) {
  const { db, phuket, proxy } = runtime;
  const app = express(); app.disable('x-powered-by'); app.set('query parser', 'simple');
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    if (!loopbackRequest(req)) return next(new ApiError(403, 'LOOPBACK_ONLY', 'Only local requests are allowed.'));
    next();
  });
  app.use('/api', (req, _res, next) => {
    if (!['GET','HEAD'].includes(req.method) && (Number(req.headers['content-length']) > 0 || req.headers['transfer-encoding']) && !req.is('application/json')) return next(new ApiError(415, 'JSON_REQUIRED', 'Expected application/json.'));
    next();
  }, express.json({ limit: '2mb' }));

  // Compile every handler against the shared route's input, output and success status.
  function route<K extends keyof ApiContract>(key: K, status: ApiContract[K]['status'], schema: ZodType<ApiContract[K]['input']> | null, fn: (data: ApiContract[K]['input'], params: Record<string, string>) => ApiContract[K]['response'] | Promise<ApiContract[K]['response']>) {
    const [method, path] = key.split(' ');
    app[method.toLowerCase() as 'get' | 'post' | 'put' | 'delete'](path, async (req, res) => {
      const input = method === 'GET' ? req.query : req.body;
      if (!schema && input !== undefined && Object.keys(input).length) throw bad('This route does not accept input.');
      const result = await fn(schema ? schema.parse(input ?? {}) : undefined as ApiContract[K]['input'], req.params as Record<string, string>);
      if (status === 204) res.status(204).end(); else res.status(status).json(result);
    });
  }
  const session = () => db.state('phuketSession');
  const token = () => { const t = session()?.token; if (!t) throw new ApiError(401, 'LOGIN_REQUIRED', 'Sign in to a Phuket account first.'); return t; };
  const authStatus = (): PhuketAuthStatus => { const s = session(); return { authenticated: !!s, account: s?.account ?? null, baseUrl: PHUKET_BASE_URL }; };
  const protocolCheck = (app: AppType, protocol: Provider['protocol']) => { if (protocolForApp(app) !== protocol) throw bad('The selected protocol is not supported by this application.'); };
  const num = v.numericId.parse.bind(v.numericId);

  route('GET /api/health', 200, null, () => ({ ok: true, app: 'phuket-switch', apiVersion: 1 }));
  route('GET /api/network/direct-bypass', 200, null, () => runtime.directBypass.getStatus({ refreshAdapters: true }));
  route('PUT /api/network/direct-bypass', 200, v.updateDirectBypass, req => runtime.directBypass.updateConfig(req));
  route('POST /api/network/direct-bypass/probe', 200, v.directBypassProbe, req => runtime.directBypass.probe(req));
  route('GET /api/direct-download', 200, null, () => getDirectDownloadStatus(db));
  route('POST /api/direct-download/preview-diff', 200, v.applyDirectDownload, req => previewDirectDownload(db, req));
  route('POST /api/direct-download/apply', 200, v.applyDirectDownload, req => applyDirectDownload(db, req));
  route('POST /api/direct-download/remove', 200, v.removeDirectDownload, req => removeDirectDownload(db, req));
  route('POST /api/direct-download/test', 200, v.testDirectDownload, req => testDirectDownload(db, req));
  route('GET /api/subagent', 200, null, () => getSubagentStatus(db));
  route('POST /api/subagent/preview-diff', 200, v.applySubagent, req => previewSubagent(db, phuket, req));
  route('POST /api/subagent/apply', 200, v.applySubagent, req => applySubagent(db, phuket, req));
  route('POST /api/subagent/remove', 200, v.removeSubagent, req => removeSubagent(db, req));
  route('POST /api/subagent/test', 200, v.testSubagent, req => testSubagent(db, req, runtime.fetch));
  route('GET /api/image-prompt', 200, null, () => getImagePromptStatus(db));
  route('POST /api/image-prompt/apply', 200, v.applyImagePrompt, req => applyImagePrompt(db, phuket, session()?.token ?? null, req));
  route('POST /api/image-prompt/remove', 200, v.removeImagePrompt, req => removeImagePrompt(db, req));
  route('GET /api/overview', 200, null, () => {
    const all = db.providers(), status = proxy.getStatus();
    return { currentProviders: all.filter(p => p.isCurrent).map(toProviderView), providerCounts: Object.fromEntries(apps.map(a => [a, all.filter(p => p.appType === a).length])) as Record<AppType, number>, liveCliStates: getLiveCliStates(all, status), proxy: status, fastMode: db.state('fastMode'), phuket: authStatus(), updatedAt: now() };
  });
  async function activeGroupKey(t: string, id: number, groupId?: number | null) {
    const { item, key } = await phuket.getRawKeyById(t, id);
    if (item.status !== 'active') throw bad('所选密钥已停用或失效，请选择可用密钥。');
    if (groupId !== undefined && item.group_id !== groupId) throw bad('所选密钥不属于当前 PhuketAI 分组。');
    return key;
  }
  async function resolveProviderApiKey(req: UpdateProviderRequest, appType: AppType) {
    if (req.apiKey !== undefined) return req.apiKey;
    if (req.phuketKeyId !== undefined) return activeGroupKey(token(), req.phuketKeyId, req.phuketGroupId);
    if (!req.autoCreatePhuketKey) throw bad('请选择一种密钥来源。');
    const t = token(), groupId = req.phuketGroupId, allowed = session()?.account.allowed_groups;
    if (!groupId) throw bad('自动新建密钥需要选择 PhuketAI 分组。');
    const group = (await phuket.getMergedGroups(t)).find(g => g.id === groupId);
    if (!group || !canCreateGroupKey(group, allowed) || !group.supportedAppTypes.includes(appType)) throw bad('当前分组不可用或不支持所选客户端，无法新建密钥。');
    return (await phuket.createKey(t, { name: req.name ?? `phuket-switch-${groupId}`, group_id: groupId })).key;
  }

  route('GET /api/providers', 200, v.providerQuery, q => db.providers(q.appType).map(toProviderView));
  route('POST /api/providers', 201, v.createProvider, async ({ phuketKeyId, autoCreatePhuketKey, ...fields }) => {
    protocolCheck(fields.appType, fields.protocol);
    if (fields.codexFastConfig) validateFastBindings(fields.codexFastConfig);
    const apiKey = await resolveProviderApiKey({ ...fields, phuketKeyId, autoCreatePhuketKey }, fields.appType);
    return toProviderView(db.createProvider({ ...fields, apiKey }));
  });
  route('PUT /api/providers/:id', 200, v.updateProvider, async ({ phuketKeyId, autoCreatePhuketKey, ...patch }, { id }) => {
    const p = db.provider(id);
    protocolCheck(p.appType, patch.protocol ?? p.protocol);
    if (patch.baseUrl !== undefined && new URL(patch.baseUrl).origin !== URL.parse(p.baseUrl)?.origin &&
        patch.apiKey === undefined && phuketKeyId === undefined && !autoCreatePhuketKey) {
      throw bad('切换供应商域名来源时请填写对应的新 API 密钥。');
    }
    if (patch.codexFastConfig) validateFastBindings(patch.codexFastConfig);
    if (phuketKeyId !== undefined || autoCreatePhuketKey) {
      patch.apiKey = await resolveProviderApiKey({ phuketKeyId, autoCreatePhuketKey, phuketGroupId: patch.phuketGroupId ?? p.phuketGroupId, name: patch.name ?? p.name }, p.appType);
    }
    return toProviderView(db.updateProvider(id, patch));
  });
  function validateFastBindings(config: GptFastConfig) {
    for (const { binding, label } of Object.values(dedicatedGroups)) {
      const id = config[binding];
      if (id != null && !db.hasProvider(id, 'openai-responses')) throw bad(`${label} 绑定需要选择现有的 Responses 供应商。`);
    }
  }
  function normalizedFastConfig(config: GptFastConfig): GptFastConfig {
    const speedMode = effectiveSpeedMode(config);
    return { ...config, speedMode, enabled: speedMode !== 'standard', serviceTier: fastTier(config, speedMode) };
  }
  function syncMenuPreference(current: Provider | null, cfg: GptFastConfig, syncSpeedMenu = true) {
    const pref = current?.codexFastConfig;
    if (!current || !pref) return;
    const fields = {
      ...(syncSpeedMenu ? { catalogSpeedVariants: cfg.catalogSpeedVariants, ultraFastProviderId: cfg.ultraFastProviderId } : {}),
      ...(cfg.astraOnlyProviderId !== undefined ? { astraOnlyProviderId: cfg.astraOnlyProviderId } : {}),
      ...(cfg.routeAstraToOnlyAstra !== undefined ? { routeAstraToOnlyAstra: cfg.routeAstraToOnlyAstra } : {}),
    };
    if ((Object.keys(fields) as (keyof typeof fields)[]).some(k => fields[k] !== pref[k])) {
      db.updateProvider(current.id, { codexFastConfig: { ...pref, ...fields } });
    }
  }
  function saveFastConfig(config: GptFastConfig) {
    db.setState('fastMode', config);
    db.setState('settings', { ...db.state('settings'), defaultGptFastConfig: config });
  }
  route('DELETE /api/providers/:id', 204, null, (_, { id }) => {
    db.deleteProvider(id);
    const unbind = (config: GptFastConfig) => {
      if (config.astraOnlyProviderId !== id && config.ultraFastProviderId !== id) return;
      return { ...config, ...(config.ultraFastProviderId === id ? { ultraFastProviderId: null } : {}),
        ...(config.astraOnlyProviderId === id ? { astraOnlyProviderId: null, routeAstraToOnlyAstra: false } : {}) };
    };
    db.transaction(() => {
      const config = unbind(db.state('fastMode'));
      if (config) saveFastConfig(config);
      for (const p of db.providers()) {
        const pref = p.codexFastConfig && unbind(p.codexFastConfig);
        if (pref) db.updateProvider(p.id, { codexFastConfig: pref });
      }
    });
  });
  route('POST /api/providers/:id/activate', 200, v.activate, (req, { id }) => {
    const p = db.provider(id), system = req.applyToSystem !== false ? applyProvider(db, p, { proxyRoot: proxy.configRoot(p.appType) }) : notApplied();
    return { provider: toProviderView(db.setCurrentProvider(p.appType, id)), system };
  });
  route('GET /api/providers/:id/preview-diff', 200, null, (_, { id }) => { const p = db.provider(id); return previewProviderDiff(db, p, proxy.configRoot(p.appType)); });
  route('POST /api/providers/:id/test', 200, null, (_, { id }) => phuket.testProvider(db.provider(id)));
  route('GET /api/fast-mode', 200, null, () => db.state('fastMode'));
  route('PUT /api/fast-mode', 200, v.updateFastMode, req => {
    validateFastBindings(req.config);
    const config = normalizedFastConfig(req.config), current = db.current('codex');
    if (req.applyToCodex && !current) throw conflict('请先选择一个当前 Codex 供应商，再应用速度设置。');
    const proxyRoot = proxy.configRoot('codex');
    const system = current && req.applyToCodex ? applyProvider(db, current, { fast: config, proxyRoot }) : notApplied();
    db.transaction(() => {
      syncMenuPreference(current, config, !!(req.applyToCodex && proxyRoot));
      saveFastConfig(config);
    });
    return { config, system };
  });
  async function dedicatedKey(req: DedicatedSetupRequest, group: PhuketGroup, t: string | null, spec: DedicatedGroup) {
    if (req.apiKey) return req.apiKey;
    if (!t) throw new ApiError(401, 'LOGIN_REQUIRED', `请先登录 PhuketAI 账号，或手动填写 ${spec.label} 分组密钥。`);
    const activeKey = (id: number) => activeGroupKey(t, id, group.id);
    if (req.phuketKeyId !== undefined) return activeKey(req.phuketKeyId);
    if (!req.autoCreatePhuketKey) {
      const seen = new Set<number>();
      for (let page = 1; ; page++) {
        const { items, total } = await phuket.listKeys(t, page, 100);
        const count = seen.size;
        for (const item of items) {
          if (seen.has(item.id)) continue;
          seen.add(item.id);
          if (item.group_id !== group.id || item.status !== 'active') continue;
          try { return await activeKey(item.id); }
          catch (e) {
            // A masked, retired or deleted key may still appear in the list. Do not mint keys on transport/auth errors.
            if (!(e instanceof ApiError) || ![400, 404, 409].includes(e.status)) throw e;
          }
        }
        if (seen.size === count || seen.size >= total) break;
      }
    }
    if (!canCreateGroupKey(group, session()?.account.allowed_groups)) throw bad(`当前账户无法为 ${spec.label} 分组新建密钥。`);
    return (await phuket.createKey(t, { name: spec.keyName, group_id: group.id })).key;
  }
  async function prepareDedicatedProvider(req: DedicatedSetupRequest, spec: DedicatedGroup) {
    const t = session()?.token ?? null;
    if (!t && !req.apiKey && req.phuketKeyId === undefined && !req.autoCreatePhuketKey) {
      const saved = db.providers('codex').filter(p => p.protocol === 'openai-responses' && spec.match(p) && (req.groupId === undefined || p.phuketGroupId === req.groupId));
      const boundId = db.state('fastMode')[spec.binding];
      const existing = saved.find(p => p.id === boundId) ?? saved.find(p => p.phuketGroupId === spec.id) ?? saved[0];
      if (existing) return existing;
      throw new ApiError(401, 'LOGIN_REQUIRED', `请先登录 PhuketAI 账号，或手动填写 ${spec.label} 分组密钥。`);
    }
    const groups = (await phuket.getMergedGroups(t)).filter(g => g.protocol === 'openai-responses' && spec.match(g));
    const group = req.groupId !== undefined ? groups.find(g => g.id === req.groupId) : groups.find(g => g.id === spec.id) ?? groups[0];
    if (!group) throw bad(`未找到所选的 ${spec.name} 专属分组。`);
    const apiKey = await dedicatedKey(req, group, t, spec), models = allowedGroupModels(group);
    return { protocol: 'openai-responses' as const, baseUrl: PHUKET_GPT_BASE_URL, apiKey, phuketGroupId: group.id, phuketGroupName: group.name, phuketPlatform: group.platform,
      rateMultiplier: group.rate_multiplier, availableModels: models, model: pickRecommendedModel(models, 'openai-responses') };
  }
  function upsertDedicatedProvider(prepared: Awaited<ReturnType<typeof prepareDedicatedProvider>>) {
    if ('id' in prepared) return prepared;
    const existing = db.providers('codex').find(p => p.phuketGroupId === prepared.phuketGroupId);
    return existing ? db.updateProvider(existing.id, prepared) : db.createProvider({ ...prepared, name: prepared.phuketGroupName, appType: 'codex' });
  }
  route('POST /api/fast-mode/setup-ultrafast', 200, v.setupUltraFast, async req => {
    if (req.applyToCodex && !req.enableCodexMenu && !db.current('codex')) throw conflict('请先选择一个当前 Codex 供应商，再应用速度设置。');
    const prepared = await prepareDedicatedProvider(req, dedicatedGroups.ultrafast);
    const result = db.transaction(() => {
      const provider = upsertDedicatedProvider(prepared);
      const fastMode = normalizedFastConfig({ ...db.state('fastMode'), ultraFastProviderId: provider.id, ...(req.enableCodexMenu ? { catalogSpeedVariants: true } : {}) });
      const current = db.current('codex');
      const system = current && req.applyToCodex && !req.enableCodexMenu ? applyProvider(db, current, { fast: fastMode, proxyRoot: proxy.configRoot('codex') }) : notApplied();
      if (req.enableCodexMenu) syncMenuPreference(current, fastMode);
      saveFastConfig(fastMode);
      return { provider: toProviderView(provider), fastMode, system };
    });
    if (!req.enableCodexMenu) return result;
    if (db.current('codex')) result.system = (await proxy.takeover('codex', true, result.fastMode)).system;
    return { ...result, proxy: proxy.getStatus() };
  });
  route('POST /api/fast-mode/setup-astra-only', 200, v.setupAstraOnly, async req => {
    const prepared = await prepareDedicatedProvider(req, dedicatedGroups.astra);
    const result = db.transaction(() => {
      const provider = upsertDedicatedProvider(prepared);
      const fastMode = { ...db.state('fastMode'), astraOnlyProviderId: provider.id, routeAstraToOnlyAstra: true };
      syncMenuPreference(db.current('codex') ?? provider, fastMode, false);
      saveFastConfig(fastMode);
      return { provider: toProviderView(db.provider(provider.id)), fastMode };
    });
    if (!db.current('codex')) result.provider = toProviderView(db.setCurrentProvider('codex', result.provider.id));
    if (req.enableProxyTakeover === false) return { ...result, system: notApplied() };
    return { ...result, ...await proxy.takeover('codex', true, db.current('codex')?.codexFastConfig ?? result.fastMode) };
  });
  route('GET /api/phuket/status', 200, null, authStatus);
  route('POST /api/phuket/login', 200, v.login, async req => {
    const result = await phuket.login(req);
    if (result.requires2fa) return { authenticated: false, account: null, baseUrl: PHUKET_BASE_URL, requires2fa: true, tempToken: result.tempToken, maskedEmail: result.maskedEmail };
    if (!result.token || !result.account) throw bad('登录未建立有效的账号会话。');
    phuket.replaceSession({ token: result.token, ...(result.refreshToken ? { refreshToken: result.refreshToken } : {}), ...(result.expiresAt ? { expiresAt: result.expiresAt } : {}), account: result.account });
    return authStatus();
  });
  route('POST /api/phuket/logout', 204, null, () => phuket.replaceSession(null));
  route('GET /api/phuket/account', 200, null, () => phuket.getAccount(token()));
  route('GET /api/phuket/payment/checkout-info', 200, null, () => phuket.checkoutInfo(token()));
  route('POST /api/phuket/payment/orders', 201, v.createOrder, req => phuket.createOrder(token(), req));
  route('GET /api/phuket/payment/orders', 200, v.ordersQuery, q => phuket.orders(token(), q));
  route('GET /api/phuket/payment/orders/:id', 200, null, (_, { id }) => phuket.order(token(), num(id)));
  route('POST /api/phuket/payment/orders/:id/cancel', 200, null, (_, { id }) => phuket.cancelOrder(token(), num(id)));
  route('POST /api/phuket/payment/orders/verify', 200, v.verifyOrder, req => phuket.verifyOrder(token(), req));
  route('POST /api/phuket/redeem', 200, v.redeem, req => phuket.redeem(token(), req));
  route('GET /api/phuket/redeem/history', 200, v.paymentPage, q => phuket.redeemHistory(token(), q));
  route('GET /api/phuket/groups', 200, null, async () => { const t = session()?.token ?? null; return { authenticated: !!t, description: t ? 'Public catalog and available account groups.' : 'Public catalog; access depends on your account.', groups: await phuket.getMergedGroups(t) }; });
  route('GET /api/phuket/keys', 200, v.keyPage, q => phuket.listKeys(token(), q.page ?? 1, q.pageSize ?? 20));
  route('POST /api/phuket/keys', 201, v.createKey, req => phuket.createKey(token(), req));
  route('PUT /api/phuket/keys/:id', 200, v.updateKey, (req, { id }) => phuket.updateKey(token(), num(id), req));
  route('DELETE /api/phuket/keys/:id', 204, null, (_, { id }) => phuket.deleteKey(token(), num(id)));
  route('POST /api/phuket/keys/:id/import-provider', 201, v.importKey, async (req, { id }) => {
    const t = token(), { item, key } = await phuket.getRawKeyById(t, num(id));
    const groups = await phuket.getMergedGroups(t), group = groups.find(g => g.id === item.group_id) ?? (item.group ? { ...item.group, ...classifyPhuketGroup(item.group), models: [] } : null);
    if (!group?.protocol) throw conflict('This key has no supported inference group.');
    const appType = req.appType ?? group.supportedAppTypes[0];
    if (!group.supportedAppTypes.includes(appType)) throw bad('This application is incompatible with the key group.');
    const models = allowedGroupModels(group), protocol = protocolForApp(appType);
    return toProviderView(db.createProvider({
      name: req.name || item.name || group.name, appType, protocol,
      baseUrl: defaultBaseUrlForApp(appType, group),
      apiKey: key, phuketGroupId: group.id, phuketGroupName: group.name, phuketPlatform: group.platform,
      rateMultiplier: group.rate_multiplier, model: req.model ?? pickRecommendedModel(models, protocol),
      availableModels: models,
      ...(protocol === 'anthropic-messages' ? { claudeModelMap: buildSuggestedClaudeMap(models) } : {}),
    }));
  });
  route('GET /api/phuket/usage', 200, v.usageQuery, q => phuket.getUsage(session()?.token ?? null, db.current('codex') ?? db.current('claude') ?? db.current('gpt-native') ?? db.current('claude-desktop') ?? db.current('gemini') ?? db.current('antigravity'), q.from, q.to));
  route('GET /api/monitors', 200, null, () => phuket.getChannelMonitors(session()?.token ?? null));
  route('GET /api/monitors/:id/status', 200, null, (_, { id }) => phuket.getChannelMonitorStatus(session()?.token ?? null, num(id)));
  route('POST /api/monitors/probe-local', 200, v.probe, req => runLocalProbe(db, req));
  route('GET /api/routes', 200, null, () => db.state('modelRoutes'));
  route('PUT /api/routes', 200, v.updateModelRoutes, ({ rules }) => db.transaction(() => {
    const providers = new Map(db.providers().map(p => [p.id, p.protocol]));
    if (rules.some(r => !providers.has(r.targetProviderId))) throw bad('Unknown target provider.');
    if (rules.some(r => providers.get(r.targetProviderId) === 'gemini-native')) throw bad('Gemini 原生供应商不支持跨协议翻译，请使用原生客户端，或选择兼容 Anthropic Messages 或 OpenAI Responses 的供应商。');
    const saved = rules.map(r => ({ ...r, id: r.id ?? randomUUID() }));
    if (new Set(saved.map(r => r.id)).size !== saved.length) throw bad('Duplicate route ID.');
    db.setState('modelRoutes', saved);
    if (!saved.some(r => r.enabled && r.sourceClient === 'codex')) db.setState('codexIncludeRoutedModels', false);
    return saved;
  }));
  route('POST /api/routes/auto-populate', 200, v.autoPopulateRoutes, ({ sourceClient = 'all', syncCodexCatalog: sync }) => {
    if (sync && !db.state('proxyTakeover').codex) throw conflict('请先在「本地代理 → 代理与接管」开启 Codex 代理接管，再同步跨协议模型到 Codex 目录。');
    const result = db.transaction(() => {
      const rules = db.state('modelRoutes'), initial = rules.length;
      const covered = new Set(rules.map(r => `${r.sourceClient}:${r.sourceModel}`));
      for (const p of db.providers()) {
        if (p.protocol === 'gemini-native') continue;
        const client = p.protocol === 'anthropic-messages' ? 'codex' : 'claude';
        if (sourceClient !== 'all' && sourceClient !== client) continue;
        for (const model of providerModelNames(p)) {
          const key = `${client}:${model}`;
          if (!MODEL_SLUG.test(model) || covered.has(key)) continue;
          rules.push({ id: randomUUID(), enabled: true, sourceClient: client, sourceModel: model, targetProviderId: p.id, targetModel: model });
          covered.add(key);
        }
      }
      db.setState('modelRoutes', rules);
      return { rules, addedCount: rules.length - initial };
    });
    return sync && db.current('codex') ? { ...result, system: syncCodexCatalog(db) } : result;
  });
  route('POST /api/routes/sync-codex-catalog', 200, null, () => syncCodexCatalog(db));
  route('POST /api/routes/clear-codex-catalog', 200, null, () => clearCodexCatalogRoutes(db));
  route('GET /api/proxy/status', 200, null, () => proxy.getStatus());
  route('PUT /api/proxy/settings', 200, v.proxySettings, req => proxy.updateSettings(req));
  route('POST /api/proxy/start', 200, null, () => proxy.start());
  route('POST /api/proxy/stop', 200, null, () => proxy.stop());
  route('POST /api/proxy/takeover', 200, v.takeover, req => proxy.takeover(req.appType, req.enable));
  route('GET /api/proxy/logs', 200, v.logs, q => db.logs(q.cursor, q.limit));
  route('DELETE /api/proxy/logs', 204, null, () => db.clearLogs());
  route('GET /api/diagnostics/workbench-models', 200, v.workbenchModels, async ({ keyId }) => {
    const t = token(), { media } = await diagnosticKey(phuket, t, keyId);
    return (await phuket.getWorkbenchModels(t, keyId)).filter(m => !media.has(m.id));
  });
  route('POST /api/diagnostics/connection', 200, v.connectionCheck, req => runConnectionCheck(db, phuket, proxy, token(), req));
  route('POST /api/lab/speed-compare', 200, v.compare, req => {
    // This benchmark explicitly requests Fast, even if the global mode is Standard or UltraFast.
    const preset = req.fastConfig ?? db.provider(req.providerId).codexFastConfig ?? db.state('fastMode');
    return runSpeedCompare(db, { ...req, fastConfig: { ...preset, speedMode: 'fast', respectClientServiceTier: false } });
  });
  route('POST /api/lab/chat-test', 200, v.chat, req => runChatTest(db, req));
  route('GET /api/extensions/mcp', 200, null, listMcp);
  route('POST /api/extensions/mcp', 200, v.mcp, req => upsertMcp(db, req));
  route('DELETE /api/extensions/mcp/:target/:name', 204, null, (_, p) => deleteMcp(db, v.target.parse(p.target), v.mcpName.parse(p.name)));
  route('GET /api/extensions/prompts', 200, null, () => db.prompts());
  route('POST /api/extensions/prompts', 201, v.prompt, req => db.createPrompt(req));
  route('PUT /api/extensions/prompts/:id', 200, v.updatePrompt, (req, { id }) => db.updatePrompt(id, req));
  route('DELETE /api/extensions/prompts/:id', 204, null, (_, { id }) => db.deletePrompt(id));
  route('POST /api/extensions/prompts/:id/apply', 200, null, (_, { id }) => applyPrompt(db, id));
  route('GET /api/extensions/skills', 200, null, listSkills);
  route('GET /api/settings', 200, null, () => db.state('settings'));
  route('PUT /api/settings', 200, v.settings, s => db.transaction(() => {
    validateFastBindings(s.defaultGptFastConfig);
    const settings = { ...db.state('settings'), ...s, defaultGptFastConfig: normalizedFastConfig(s.defaultGptFastConfig) };
    db.setState('settings', settings); db.setState('fastMode', settings.defaultGptFastConfig);
    return settings;
  }));
  route('GET /api/backups', 200, null, () => db.backups());
  route('POST /api/backups/:id/restore', 200, null, (_, { id }) => restoreBackup(db, id));
  route('GET /api/cc-switch/detect', 200, null, detectCcSwitch);
  route('POST /api/cc-switch/import', 200, v.importCc, req => importCcSwitch(db, req.sourceIds));

  const notFound: express.RequestHandler = (_req, _res, next) => next(new ApiError(404, 'NOT_FOUND', 'Route not found.'));
  app.use('/api', notFound);
  app.use(express.static(webRoot, { index: false, redirect: false }));
  app.get(/.*/, (req, res, next) => { if (!req.accepts('html')) return next(); res.set('Cache-Control', 'no-cache').sendFile('index.html', { root: resolve(webRoot) }); });
  app.use(notFound);
  const errors: express.ErrorRequestHandler = (err, _req, res, next) => {
    if (res.headersSent) return next(err);
    const e = err instanceof ApiError ? err : err instanceof ZodError ? bad(err.issues[0]?.message || `Invalid request field: ${err.issues[0]?.path.join('.') || 'input'}.`) : err.status === 400 ? bad('Invalid JSON or path encoding.') : err.status === 413 ? new ApiError(413, 'TOO_LARGE', 'Request body is too large.') : err.status === 404 ? new ApiError(404, 'NOT_FOUND', 'Resource not found.') : new ApiError(500, 'INTERNAL_ERROR', 'Unable to complete this request.');
    res.status(e.status).json({ error: { code: e.code, message: e.message } } satisfies ApiErrorResponse);
  };
  app.use(errors); return app;
}
