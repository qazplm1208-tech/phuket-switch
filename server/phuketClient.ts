import { APP_VERSION, classifyPhuketGroup, FALLBACK_PHUKET_GROUPS, PHUKET_BASE_URL } from '../shared/constants.js';
import type { CreatePhuketKeyRequest, PhuketAccount, PhuketGroup, PhuketKeysPage, PhuketLoginRequest, PhuketUsageResponse, Provider, ProviderTestResult, UpdatePhuketKeyRequest } from '../shared/types.js';
import type { CreatePaymentOrderRequest, PaymentOrdersQuery, PaymentPageQuery, VerifyPaymentOrderRequest, RedeemRequest, RedeemResult } from '../shared/types.js';
import type { PhuketSession, SwitchDb } from './db.js';
import { ApiError, asNumber, bad, conflict, elapsed, isRecord, missing, normalizeLoginEmail, normalizeLoginPassword, normalizeLoginToken, now, own, redactRecognizable, stripV1, stripV1Beta, upstreamError } from './common.js';
import { checkStatus, fetchJson, fetchJsonResponse, type Fetch } from './httpClient.js';
import { checkInference, diagnosticPrompt } from './diagnosticTransport.js';
import { isWorkbenchChatModel } from '../shared/constants.js';
import type { WorkbenchModelOption } from '../shared/types.js';
import * as view from './phuketViews.js';

type Credentials = Omit<PhuketSession, 'account'>;
type LoginResult = (PhuketSession & { requires2fa?: false }) | { requires2fa: true; token: null; account: null; tempToken: string; maskedEmail?: string };
const userAgent = `PhuketSwitch/${APP_VERSION} (Windows; +${PHUKET_BASE_URL})`;
const sessionChanged = () => conflict('账号会话已变更，请重试。');
function credential(value: unknown): string | undefined {
  if (typeof value !== 'string' || /[\r\n]/.test(value)) return;
  const text = value.trim();
  return text && !/^sk-/i.test(text) ? text : undefined;
}
function expiry(seconds: number | null = null) {
  const nowMs = Date.now(), at = nowMs + Math.max(60, Math.floor(seconds ?? 3600)) * 1000;
  return Number.isSafeInteger(at) ? at : nowMs + 3_600_000;
}
function accountBalance(row: Record<string, unknown>) {
  return asNumber(row.balance) ?? asNumber(row.credits) ?? asNumber(row.quota) ?? asNumber(row.remain_quota);
}
function accountFrom(value: unknown): PhuketAccount | null {
  const row = own(value);
  const email = typeof row.email === 'string' ? row.email.trim() : '', username = typeof row.username === 'string' ? row.username.trim() : '';
  if (!email && !username) return null;
  // A minimal login profile can lack an ID or email. Never use its placeholder ID to identify a session.
  return view.account({ ...row, id: asNumber(row.id) ?? 0, email, username, balance: accountBalance(row) ?? 0 });
}
const unwrap = (v: unknown): any => isRecord(v) && Object.hasOwn(v, 'data') ? v.data : v;
function auth(token: string | null): Record<string, string> {
  if (!token) return { 'user-agent': userAgent };
  if (/^sk-/i.test(token)) throw new ApiError(401, 'USER_SESSION_REQUIRED', 'Use a Phuket account session, not a provider key.');
  return { ...(token.startsWith('cookie:') ? { Cookie: token.slice(7) } : { Authorization: `Bearer ${token}` }), 'x-user-ui-request': '1', 'user-agent': userAgent };
}
export function timezoneURL(route: string, query: Record<string, string> = {}, base = PHUKET_BASE_URL) {
  const u = new URL(`/api/v1/${route}`, base);
  for (const [k, v] of Object.entries({ ...query, timezone: 'Asia/Shanghai' })) u.searchParams.set(k, v);
  return u;
}
export function providerHeaders(p: Provider): Record<string, string> {
  return { Authorization: `Bearer ${p.apiKey}`, ...(URL.parse(p.baseUrl)?.origin === PHUKET_BASE_URL ? { 'user-agent': userAgent } : {}), ...(p.protocol === 'gemini-native' ? { 'x-goog-api-key': p.apiKey } : p.protocol === 'anthropic-messages' ? { 'x-api-key': p.apiKey } : {}) };
}
function scrubAuthError(error: unknown, ...values: string[]) {
  if (!(error instanceof ApiError)) return error;
  const secrets = values.flatMap(v => v.startsWith('cookie:') ? [v, ...v.slice(7).split(';').map(part => part.slice(part.indexOf('=') + 1).trim())] : [v]).filter(Boolean);
  const scrub = (text: string) => redactRecognizable(secrets.reduce((s, secret) => s.replaceAll(secret, '[REDACTED]'), text));
  return new ApiError(error.status, scrub(error.code), scrub(error.message));
}
export class PhuketClient {
  private sessionGeneration = 0;
  private rotated?: { from: string; to: string };
  private refreshing?: { token: string; refreshToken: string; promise: Promise<PhuketSession> };
  constructor(private readonly db: SwitchDb, private readonly send: Fetch = fetch, private readonly base = PHUKET_BASE_URL) {}

  replaceSession(session: PhuketSession | null) {
    this.db.setState('phuketSession', session);
    this.sessionGeneration++; this.rotated = undefined; this.refreshing = undefined;
  }
  private sessionFor(token: string | null) {
    if (!token) return null;
    const s = this.db.state('phuketSession');
    // Multi-step operations can still hold the access token from just before rotation.
    return s && (s.token === token || (this.rotated?.from === token && this.rotated.to === s.token)) ? s : null;
  }
  async refreshSession(refreshToken: string): Promise<PhuketSession> {
    const previous = this.db.state('phuketSession'), generation = this.sessionGeneration;
    if (!previous || !credential(refreshToken) || previous.refreshToken !== refreshToken) throw sessionChanged();
    if (this.refreshing?.token === previous.token && this.refreshing.refreshToken === refreshToken) return this.refreshing.promise;
    const current = () => {
      const s = this.db.state('phuketSession');
      return generation === this.sessionGeneration && s?.token === previous.token && s.refreshToken === refreshToken ? s : null;
    };
    const promise = (async () => {
      try {
        const { json, response } = await this.authPost('auth/refresh', { refresh_token: refreshToken });
        const tokens = this.credentialsFrom(json, response);
        if (!tokens) throw upstreamError();
        const active = current(); if (!active) throw sessionChanged();
        const account = accountFrom(own(json.data).user) ?? accountFrom(json.user) ?? active.account;
        const next = { ...tokens, refreshToken: tokens.refreshToken ?? refreshToken, account };
        this.db.setState('phuketSession', next);
        this.rotated = { from: previous.token, to: next.token };
        return next;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401 && current()) this.replaceSession(null);
        throw scrubAuthError(err, refreshToken, previous.token);
      }
    })();
    this.refreshing = { token: previous.token, refreshToken, promise };
    try { return await promise; } finally { if (this.refreshing?.promise === promise) this.refreshing = undefined; }
  }
  private async withSession<T>(token: string | null, run: (access: string | null) => Promise<T>, managed = true): Promise<T> {
    const generation = this.sessionGeneration;
    let s = managed ? this.sessionFor(token) : null, refreshed = false;
    if (s?.refreshToken && (this.refreshing?.token === s.token || (s.expiresAt !== undefined && Date.now() >= s.expiresAt - 60_000))) {
      s = await this.refreshSession(s.refreshToken); refreshed = true;
    }
    for (;;) {
      const access = s?.token ?? token, rotation = this.rotated;
      if (s && this.sessionGeneration !== generation) throw sessionChanged();
      try {
        const result = await run(access);
        if (s && this.sessionGeneration !== generation) throw sessionChanged();
        return result;
      } catch (e) {
        const failure = scrubAuthError(e, access ?? '', s?.refreshToken ?? '');
        if (!s || !(failure instanceof ApiError) || failure.status !== 401 || this.sessionGeneration !== generation) throw failure;
        const active = this.sessionFor(access);
        if (!active) throw failure;
        if (!active.refreshToken) { if (active.token === access) this.replaceSession(null); throw failure; }
        if (refreshed) throw failure;
        // A concurrent request may already have refreshed before this late 401 arrived.
        s = this.rotated !== rotation || active.token !== access ? active : await this.refreshSession(active.refreshToken);
        refreshed = true;
      }
    }
  }
  private async request(route: string, token: string | null, method: string, body?: unknown, query?: Record<string, string>, tz = true, retryAgreement = true, managed = true): Promise<unknown> {
    const url = tz ? timezoneURL(route, query, this.base) : new URL(`/api/v1/${route}`, this.base);
    const send = (access: string | null) => fetchJson(url, { method, headers: { ...auth(access), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined }, this.send);
    return this.withSession(token, async access => {
      try { return await send(access); }
      catch (error) {
        if (!retryAgreement || !access || !(error instanceof ApiError) || error.status !== 423) throw error;
        retryAgreement = false;
        await this.ensureAgreementAccepted(access, managed);
        return send(managed ? this.sessionFor(access)?.token ?? access : access);
      }
    }, managed);
  }
  private async call(route: string, token: string | null, method = 'GET', body?: unknown, query?: Record<string, string>, tz = true) {
    return unwrap(await this.request(route, token, method, body, query, tz));
  }
  private async paymentCall(route: string, token: string, method = 'GET', body?: unknown, query?: Record<string, string>) {
    const envelope = await this.request(route, token, method, body, query, method === 'GET');
    if (!isRecord(envelope) || envelope.code !== 0 || !Object.hasOwn(envelope, 'data')) throw upstreamError();
    return envelope.data;
  }
  async ensureAgreementAccepted(token: string, managed = true) {
    const agreement = own(unwrap(await this.request('user/agreement', token, 'GET', undefined, undefined, false, false, managed)));
    const revision = agreement.revision;
    if (agreement.required === true && typeof revision === 'string' && revision) {
      await this.request('user/agreement/accept', token, 'POST', { revision, accepted: true, language: 'zh' }, undefined, false, false, managed);
    }
  }
  private async authPost(route: string, body: Record<string, string>) {
    try {
      const result = await fetchJsonResponse(new URL(`/api/v1/${route}`, this.base), {
        method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', 'accept-language': 'zh-CN', 'user-agent': userAgent }, body: JSON.stringify(body),
      }, this.send);
      const json = own(result.json);
      const challenge = route === 'auth/login' && own(json.data).requires_2fa === true;
      if (json.code !== undefined && json.code !== 0 && json.code !== '0' && !challenge) checkStatus(route === 'auth/refresh' ? 502 : 401, json);
      return { response: result.response, json };
    } catch (error) {
      throw scrubAuthError(error, ...Object.values(body));
    }
  }
  private credentialsFrom(json: Record<string, any>, response: Response): Credentials | null {
    const data = own(json.data);
    const fields = (...names: string[]) => [data, json].flatMap(row => names.map(name => row[name]));
    let token = fields('access_token', 'accessToken', 'token').map(credential).find(Boolean);
    if (!token) {
      const cookies = response.headers.getSetCookie().map(c => c.split(';')[0]).filter(Boolean);
      const jwt = cookies.map(c => /^(?:access_token|jwt|token)=(.+)$/i.exec(c)?.[1]).find(Boolean);
      try { token = credential(jwt ? decodeURIComponent(jwt) : cookies.length ? `cookie:${cookies.join('; ')}` : undefined); }
      catch { return null; }
    }
    if (!token) return null;
    const refreshToken = fields('refresh_token', 'refreshToken').map(credential).find(Boolean);
    const seconds = fields('expires_in', 'expiresIn').map(asNumber).find(v => v !== null);
    return { token, ...(refreshToken ? { refreshToken } : {}), expiresAt: expiry(seconds) };
  }
  private async completeLogin(json: Record<string, any>, response: Response): Promise<PhuketSession> {
    const credentials = this.credentialsFrom(json, response);
    if (!credentials) throw new ApiError(401, 'LOGIN_FAILED', '登录未返回有效的账号会话。');
    await this.ensureAgreementAccepted(credentials.token, false).catch(() => undefined);
    try {
      return { ...credentials, account: await this.getAccount(credentials.token, false, false) };
    } catch (error) {
      const fallback = accountFrom(own(json.data).user) ?? accountFrom(json.user);
      if (fallback && !(error instanceof ApiError && error.status === 401)) return { ...credentials, account: fallback };
      throw scrubAuthError(error, credentials.token, credentials.refreshToken ?? '');
    }
  }
  async login(req: PhuketLoginRequest): Promise<LoginResult> {
    if (req.refreshToken !== undefined && (req.token === undefined || !credential(req.refreshToken))) throw bad('刷新令牌仅用于 Token 登录，且不能是 API 密钥。');
    if (req.token !== undefined) {
      const token = normalizeLoginToken(req.token);
      if (!token) throw bad('请输入有效的登录 Token。');
      if (/^sk-/i.test(token)) throw bad('您输入的是 API 密钥（sk-...），不是账号登录 Token。API 密钥请直接在「供应商 → 添加供应商」中使用；如需登录账号请使用邮箱密码或网页控制台的 auth_token。');
      await this.ensureAgreementAccepted(token, false).catch(() => undefined);
      const refreshToken = credential(req.refreshToken);
      try { return { token, ...(refreshToken ? { refreshToken } : {}), expiresAt: expiry(), account: await this.getAccount(token, false, false) }; }
      catch (e) { throw scrubAuthError(e, token, refreshToken ?? ''); }
    }
    if (req.tempToken !== undefined || req.totpCode !== undefined) {
      if (!req.tempToken || !req.totpCode?.trim()) throw bad('两步验证需要临时 Token 和 6 位动态验证码。');
      const result = await this.authPost('auth/login/2fa', { temp_token: req.tempToken, totp_code: req.totpCode.trim() });
      if (result.json.code !== undefined && result.json.code !== 0 && result.json.code !== '0') checkStatus(401, result.json);
      return this.completeLogin(result.json, result.response);
    }
    if (req.email !== undefined || req.password !== undefined) {
      if (req.email === undefined || req.password === undefined) throw bad('邮箱和密码必须同时填写。');
      const email = normalizeLoginEmail(req.email), password = normalizeLoginPassword(req.password);
      if (/^sk-/i.test(email) || /^sk-/i.test(password.trim())) throw bad('您输入的是 API 密钥（sk-...），不是账号登录凭据。API 密钥请直接在「供应商 → 添加供应商」中使用；如需登录账号请使用邮箱密码或网页控制台的 auth_token。');
      const result = await this.authPost('auth/login', { email, password });
      const data = own(result.json.data);
      if (data.requires_2fa === true && data.temp_token) {
        return { token: null, account: null, requires2fa: true, tempToken: String(data.temp_token), maskedEmail: typeof data.user_email_masked === 'string' ? data.user_email_masked : email };
      }
      return this.completeLogin(result.json, result.response);
    }
    throw bad('请选择邮箱密码登录或 Token 登录。');
  }
  async getAccount(token: string, requireBalance = false, managed = true) {
    const tracked = managed && this.sessionFor(token), generation = this.sessionGeneration;
    const data = unwrap(await this.request('auth/me', token, 'GET', undefined, undefined, false, true, managed));
    const account = accountFrom(data);
    if (!account || (requireBalance && accountBalance(own(data)) === null)) throw upstreamError();
    const current = tracked && generation === this.sessionGeneration && this.sessionFor(token);
    if (current) this.db.setState('phuketSession', { ...current, account });
    return account;
  }
  async getMergedGroups(token: string | null): Promise<PhuketGroup[]> {
    // Never reinterpret an inference credential as an account token, including in public mode.
    if (token && /^sk-/i.test(token)) token = null;
    const [plaza, available, rates] = await Promise.allSettled([this.call('model-plaza', token), token ? this.call('groups/available', token) : [], token ? this.call('groups/rates', token) : {}]);
    if (available.status === 'rejected') throw available.reason;
    if (plaza.status === 'rejected' && !token) return structuredClone(FALLBACK_PHUKET_GROUPS);
    const merged = new Map<number, Record<string, any>>();
    for (const group of [...view.rows(plaza.status === 'fulfilled' ? plaza.value : null, 'groups'), ...view.rows(available.value, 'groups')]) {
      const id = asNumber(group.id); if (id === null || !Number.isInteger(id)) continue;
      const previous = merged.get(id); merged.set(id, { ...previous, ...group, id, models: group.models?.length ? group.models : previous?.models ?? [] });
    }
    const data = rates.status === 'fulfilled' ? rates.value : null, byId = own(data).rates ?? data;
    const rateList = view.rows(byId, 'groups');
    return [...merged.values()].map(r => {
      const meta = view.metadata(r), override = own(byId)[meta.id] ?? rateList.find(g => Number(g.group_id ?? g.id) === meta.id);
      const rate = asNumber(isRecord(override) ? override.rate_multiplier ?? override.user_rate_multiplier : override);
      if (rate !== null) meta.rate_multiplier = rate;
      return { ...meta, models: view.rows(r.models).map(view.groupModel), ...classifyPhuketGroup(meta) };
    });
  }
  async checkoutInfo(token: string) {
    return view.checkoutInfo(await this.paymentCall('payment/checkout-info', token));
  }
  async createOrder(token: string, req: CreatePaymentOrderRequest) {
    return view.paymentOrder(await this.paymentCall('payment/orders', token, 'POST', {
      ...req, is_mobile: false, payment_source: 'hosted_redirect', return_url: `${PHUKET_BASE_URL}/payment/result`,
    }));
  }
  async orders(token: string, { page = 1, page_size = 20, status }: PaymentOrdersQuery) {
    const q = { page: String(page), page_size: String(page_size), ...(status ? { status } : {}) };
    return view.paymentOrders(await this.paymentCall('payment/orders/my', token, 'GET', undefined, q));
  }
  async order(token: string, id: number) {
    return view.paymentOrder(await this.paymentCall(`payment/orders/${id}`, token));
  }
  async cancelOrder(token: string, id: number) {
    await this.paymentCall(`payment/orders/${id}/cancel`, token, 'POST');
    return { ok: true } as const;
  }
  async verifyOrder(token: string, body: VerifyPaymentOrderRequest) {
    return view.paymentOrder(await this.paymentCall('payment/orders/verify', token, 'POST', body));
  }
  async redeem(token: string, body: RedeemRequest): Promise<RedeemResult> {
    const data = own(await this.paymentCall('redeem', token, 'POST', body));
    return { ok: true, ...(typeof data.type === 'string' ? { type: data.type } : {}), ...(typeof data.value === 'number' ? { value: data.value } : {}) };
  }
  async redeemHistory(token: string, { page = 1, page_size = 20 }: PaymentPageQuery) {
    return view.redeemHistory(await this.paymentCall('redeem/history', token, 'GET', undefined, { page: String(page), page_size: String(page_size) }));
  }
  private async keys(token: string, page: number, pageSize: number) {
    const data = await this.call('keys', token, 'GET', undefined, { page: String(page), page_size: String(pageSize), sort_by: 'created_at', sort_order: 'desc' });
    const items = view.rows(data, 'keys'); return { items, total: asNumber(own(data).total) ?? items.length };
  }
  private async costs(token: string, ids: number[]) { return ids.length ? view.keyCosts(await this.call('usage/dashboard/api-keys-usage', token, 'POST', { api_key_ids: ids })) : []; }
  async listKeys(token: string, page: number, pageSize: number): Promise<PhuketKeysPage> {
    const { items, total } = await this.keys(token, page, pageSize);
    const costs = await this.costs(token, items.map(k => k.id)).catch(() => []);
    return { items: items.map(k => view.keyView(k, costs.find(c => c.api_key_id === k.id))), page, pageSize, total };
  }
  async getRawKeyById(token: string, id: number) {
    const size = 100, ids = new Set<number>();
    for (let page = 1; page <= 10000; page++) {
      const batch = await this.keys(token, page, size);
      const found = batch.items.find(k => Number(k.id) === id);
      if (found) {
        if (typeof found.key !== 'string' || !found.key || /\*{2}|\.{3}|\u2026/.test(found.key)) throw conflict('This upstream key has no importable secret.');
        return { item: view.keyView(found), key: found.key };
      }
      const previousSize = ids.size; for (const k of batch.items) ids.add(Number(k.id));
      if (previousSize === ids.size || ids.size >= batch.total) break;
    }
    throw missing('Phuket key');
  }
  async createKey(token: string, body: CreatePhuketKeyRequest) {
    const data = own(await this.call('keys', token, 'POST', body)), row = own(data.item ?? data);
    const key = row.key ?? data.key; if (typeof key !== 'string' || !key) throw upstreamError();
    return { item: view.keyView(row), key };
  }
  async updateKey(token: string, id: number, body: UpdatePhuketKeyRequest) { return view.keyView(await this.call(`keys/${id}`, token, 'PUT', body)); }
  async deleteKey(token: string, id: number) { await this.call(`keys/${id}`, token, 'DELETE'); }
  async getUsage(token: string | null, provider: Provider | null, from?: string, to?: string): Promise<PhuketUsageResponse> {
    if (token) {
      const query = { ...(from ? { start_date: from } : {}), ...(to ? { end_date: to } : {}) };
      const results = await Promise.allSettled(['usage/dashboard/stats','usage/dashboard/trend','usage/dashboard/models','usage'].map((route, i) => this.call(route, token, 'GET', undefined, i === 3 ? { ...query, page: '1', page_size: '20' } : query)));
      const [stat, trend, models, logs] = results.map(r => r.status === 'fulfilled' ? r.value : null);
      const fallback = !stat ? await this.keys(token, 1, 100).then(k => this.costs(token, k.items.map(r => r.id))).catch(() => null) : null;
      return { source: 'dashboard', dashboard: { stats: stat ? view.stats(stat) : null, trend: view.trend(trend), models: view.modelUsage(models), recentLogs: view.usageLogs(logs), keyUsageFallback: fallback }, keyUsage: null };
    }
    if (provider?.apiKey) {
      const keyUsage = view.keySnapshot(unwrap(await fetchJson(new URL('/v1/usage', provider.baseUrl), { headers: providerHeaders(provider) }, this.send)));
      return { source: 'key', dashboard: null, keyUsage, providerId: provider.id };
    }
    return { source: 'none', dashboard: null, keyUsage: null };
  }
  async getWorkbenchModels(token: string, keyId: number): Promise<WorkbenchModelOption[]> {
    const data = await this.call('workbench/models', token, 'GET', undefined, { kind: 'chat', key_id: String(keyId) });
    const rows = Array.isArray(data) ? data : data?.models;
    if (!Array.isArray(rows)) throw upstreamError();
    const options = new Map<string, WorkbenchModelOption>();
    for (const row of rows) {
      const id = typeof row === 'string' ? row : row?.id;
      if (typeof id === 'string' && isWorkbenchChatModel(id)) options.set(id, { id, label: typeof row?.label === 'string' ? row.label : id });
    }
    return [...options.values()];
  }
  runWorkbenchChatCheck(token: string, keyId: number, model: string) {
    return checkInference(this.send, new URL('/api/v1/workbench/chat/completions', this.base).href, model,
      { ...auth(token), 'X-API-Key-ID': String(keyId) }, { model, messages: [{ role: 'user', content: diagnosticPrompt }], stream: true, max_tokens: 32 }, [token]);
  }
  runLocalConnectionCheck(endpoint: string, key: string, model: string) {
    return checkInference(this.send, endpoint, model, { Authorization: `Bearer ${key}` },
      { model, input: diagnosticPrompt, max_output_tokens: 32, store: false, stream: true }, [key]);
  }
  async getChannelMonitors(token: string | null) { return view.monitors(await this.call('channel-monitors', token)); }
  async getChannelMonitorStatus(token: string | null, id: number) { return view.monitorDetail(await this.call(`channel-monitors/${id}/status`, token)); }
  async testProvider(p: Provider): Promise<ProviderTestResult> {
    const start = performance.now();
    const headers = providerHeaders(p), base = p.protocol === 'gemini-native' ? stripV1Beta(p.baseUrl) : stripV1(p.baseUrl);
    const discover = async () => {
      const get = (path: string) => fetchJson(`${base}${path}`, { headers }, this.send);
      if (p.protocol !== 'gemini-native') return get('/v1/models');
      try { return await get('/v1beta/models'); }
      catch (e) { if (!(e instanceof ApiError) || ![404, 405].includes(e.status)) throw e; return get('/v1/models'); }
    };
    const [model, usage] = await Promise.allSettled([discover(), fetchJson(new URL('/v1/usage', p.baseUrl), { headers }, this.send)]);
    const names = model.status === 'fulfilled' ? view.rows(unwrap(model.value), 'models').map(r => r.id ?? r.name).filter((v): v is string => typeof v === 'string') : [];
    const models = p.protocol === 'gemini-native' ? names.map(name => name.replace(/^models\//, '')) : names;
    const latencyMs = elapsed(start), testedAt = now(), modelsOk = model.status === 'fulfilled', usageOk = usage.status === 'fulfilled' && isRecord(unwrap(usage.value));
    const ok = modelsOk; // Some otherwise functional OpenAI-compatible servers have no /usage endpoint.
    this.db.updateProvider(p.id, { lastLatencyMs: latencyMs, lastTestedAt: testedAt, lastTestOk: ok, ...(modelsOk ? { availableModels: models } : {}) });
    return { providerId: p.id, ok, latencyMs, modelsOk, modelsCount: models.length, models, usageOk, usage: usageOk && usage.status === 'fulfilled' ? view.keySnapshot(unwrap(usage.value)) : null, testedAt, ...(!ok ? { error: 'Model discovery failed.' } : {}) };
  }
}
