import type { ApiContract, ApiErrorResponse, ApiResponse, AppType, McpTarget } from '@shared/types';

type Route = keyof ApiContract;
type Input<R extends Route> = ApiContract[R]['input'];
type Params = Record<string, string | number>;
export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiFailure';
  }
}

// Route literals bind both sides of each request to the shared JSON contract.
async function send<R extends Route>(
  route: R,
  input: Input<R>,
  params: Params = {},
  signal?: AbortSignal,
): Promise<ApiResponse<R>> {
  const [method, template] = route.split(' ');
  let path = template.replace(/:([a-zA-Z]+)/g, (_, k: string) => encodeURIComponent(String(params[k])));
  if (method === 'GET' && input) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(input)) if (value != null) query.set(key, String(value));
    if (query.size) path += '?' + query.toString();
  }
  const hasBody = method !== 'GET' && input !== undefined;
  const timer = AbortSignal.timeout(
    path.startsWith('/api/lab/')
      ? 600_000
      : path === '/api/phuket/login' || path.endsWith('/connection') || path.endsWith('/test') || path.endsWith('/probe-local')
        ? 180_000
        : 45_000,
  );
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: hasBody
        ? { 'Content-Type': 'application/json', Accept: 'application/json' }
        : { Accept: 'application/json' },
      body: hasBody ? JSON.stringify(input) : undefined,
      signal: signal ? AbortSignal.any([signal, timer]) : timer,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiFailure(
      0,
      timer.aborted ? 'TIMEOUT' : 'NETWORK',
      timer.aborted ? '请求超时，请检查端点后重试。' : '无法连接本地管理服务。',
    );
  }
  if (!response.ok) {
    const failure = (await response.json().catch(() => null)) as ApiErrorResponse | null;
    throw new ApiFailure(
      response.status,
      failure?.error?.code || 'HTTP_ERROR',
      failure?.error?.message || `管理接口返回 HTTP ${response.status}`,
    );
  }
  if (response.status === 204) return undefined as ApiResponse<R>;
  try {
    return (await response.json()) as ApiResponse<R>;
  } catch {
    throw new ApiFailure(response.status, 'INVALID_JSON', '本地管理接口没有返回有效的 JSON。');
  }
}

export const api = {
  health: (s?: AbortSignal) => send('GET /api/health', undefined, {}, s),
  overview: (s?: AbortSignal) => send('GET /api/overview', undefined, {}, s),
  providers: (appType?: AppType, s?: AbortSignal) => send('GET /api/providers', { appType }, {}, s),
  createProvider: (body: Input<'POST /api/providers'>) => send('POST /api/providers', body),
  updateProvider: (id: string, body: Input<'PUT /api/providers/:id'>) =>
    send('PUT /api/providers/:id', body, { id }),
  deleteProvider: (id: string) => send('DELETE /api/providers/:id', undefined, { id }),
  activateProvider: (id: string, body: Input<'POST /api/providers/:id/activate'>) =>
    send('POST /api/providers/:id/activate', body, { id }),
  previewDiff: (id: string, s?: AbortSignal) =>
    send('GET /api/providers/:id/preview-diff', undefined, { id }, s),
  testProvider: (id: string) => send('POST /api/providers/:id/test', undefined, { id }),
  fastMode: (s?: AbortSignal) => send('GET /api/fast-mode', undefined, {}, s),
  updateFastMode: (body: Input<'PUT /api/fast-mode'>) => send('PUT /api/fast-mode', body),
  setupUltraFast: (body: Input<'POST /api/fast-mode/setup-ultrafast'> = {}) =>
    send('POST /api/fast-mode/setup-ultrafast', body),
  auth: (s?: AbortSignal) => send('GET /api/phuket/status', undefined, {}, s),
  login: (body: Input<'POST /api/phuket/login'>) => send('POST /api/phuket/login', body),
  logout: () => send('POST /api/phuket/logout', undefined),
  account: (s?: AbortSignal) => send('GET /api/phuket/account', undefined, {}, s),
  checkoutInfo: (s?: AbortSignal) => send('GET /api/phuket/payment/checkout-info', undefined, {}, s),
  createOrder: (body: Input<'POST /api/phuket/payment/orders'>) => send('POST /api/phuket/payment/orders', body),
  orders: (q: Input<'GET /api/phuket/payment/orders'> = {}, s?: AbortSignal) => send('GET /api/phuket/payment/orders', q, {}, s),
  order: (id: number, s?: AbortSignal) => send('GET /api/phuket/payment/orders/:id', undefined, { id }, s),
  cancelOrder: (id: number) => send('POST /api/phuket/payment/orders/:id/cancel', undefined, { id }),
  verifyOrder: (out_trade_no: string) => send('POST /api/phuket/payment/orders/verify', { out_trade_no }),
  redeem: (code: string) => send('POST /api/phuket/redeem', { code }),
  redeemHistory: (q: Input<'GET /api/phuket/redeem/history'> = {}, s?: AbortSignal) => send('GET /api/phuket/redeem/history', q, {}, s),
  groups: (s?: AbortSignal) => send('GET /api/phuket/groups', undefined, {}, s),
  subagent: (s?: AbortSignal) => send('GET /api/subagent', undefined, {}, s),
  previewSubagent: (body: Input<'POST /api/subagent/preview-diff'>) => send('POST /api/subagent/preview-diff', body),
  applySubagent: (body: Input<'POST /api/subagent/apply'>) => send('POST /api/subagent/apply', body),
  removeSubagent: (body: Input<'POST /api/subagent/remove'>) => send('POST /api/subagent/remove', body),
  testSubagent: (body: Input<'POST /api/subagent/test'> = {}) => send('POST /api/subagent/test', body),
  imagePrompt: (s?: AbortSignal) => send('GET /api/image-prompt', undefined, {}, s),
  keys: (query: Input<'GET /api/phuket/keys'> = {}, s?: AbortSignal) =>
    send('GET /api/phuket/keys', query, {}, s),
  applyImagePrompt: (body: Input<'POST /api/image-prompt/apply'>) => send('POST /api/image-prompt/apply', body),
  removeImagePrompt: (body: Input<'POST /api/image-prompt/remove'>) => send('POST /api/image-prompt/remove', body),
  createKey: (body: Input<'POST /api/phuket/keys'>) => send('POST /api/phuket/keys', body),
  updateKey: (id: number, body: Input<'PUT /api/phuket/keys/:id'>) =>
    send('PUT /api/phuket/keys/:id', body, { id }),
  deleteKey: (id: number) => send('DELETE /api/phuket/keys/:id', undefined, { id }),
  importKey: (id: number, body: Input<'POST /api/phuket/keys/:id/import-provider'> = {}) =>
    send('POST /api/phuket/keys/:id/import-provider', body, { id }),
  usage: (query: Input<'GET /api/phuket/usage'> = {}, s?: AbortSignal) =>
    send('GET /api/phuket/usage', query, {}, s),
  monitors: (s?: AbortSignal) => send('GET /api/monitors', undefined, {}, s),
  monitorDetail: (id: number, s?: AbortSignal) =>
    send('GET /api/monitors/:id/status', undefined, { id }, s),
  probeLocal: (body: Input<'POST /api/monitors/probe-local'>) =>
    send('POST /api/monitors/probe-local', body),
  routes: (s?: AbortSignal) => send('GET /api/routes', undefined, {}, s),
  saveRoutes: (body: Input<'PUT /api/routes'>) => send('PUT /api/routes', body),
  autoPopulateRoutes: (body: Input<'POST /api/routes/auto-populate'>) => send('POST /api/routes/auto-populate', body),
  syncCodexCatalog: () => send('POST /api/routes/sync-codex-catalog', undefined),
  clearCodexCatalogRoutes: () => send('POST /api/routes/clear-codex-catalog', undefined),
  proxy: (s?: AbortSignal) => send('GET /api/proxy/status', undefined, {}, s),
  proxySettings: (body: Input<'PUT /api/proxy/settings'>) => send('PUT /api/proxy/settings', body),
  startProxy: () => send('POST /api/proxy/start', undefined),
  stopProxy: () => send('POST /api/proxy/stop', undefined),
  takeover: (body: Input<'POST /api/proxy/takeover'>) => send('POST /api/proxy/takeover', body),
  logs: (query: Input<'GET /api/proxy/logs'> = {}, s?: AbortSignal) =>
    send('GET /api/proxy/logs', query, {}, s),
  clearLogs: () => send('DELETE /api/proxy/logs', undefined),
  workbenchModels: (keyId: number, s?: AbortSignal) => send('GET /api/diagnostics/workbench-models', { keyId }, {}, s),
  connectionCheck: (body: Input<'POST /api/diagnostics/connection'>) => send('POST /api/diagnostics/connection', body),
  speedCompare: (body: Input<'POST /api/lab/speed-compare'>) =>
    send('POST /api/lab/speed-compare', body),
  chatTest: (body: Input<'POST /api/lab/chat-test'>) => send('POST /api/lab/chat-test', body),
  mcp: (s?: AbortSignal) => send('GET /api/extensions/mcp', undefined, {}, s),
  upsertMcp: (body: Input<'POST /api/extensions/mcp'>) => send('POST /api/extensions/mcp', body),
  deleteMcp: (target: McpTarget, name: string) =>
    send('DELETE /api/extensions/mcp/:target/:name', undefined, { target, name }),
  prompts: (s?: AbortSignal) => send('GET /api/extensions/prompts', undefined, {}, s),
  createPrompt: (body: Input<'POST /api/extensions/prompts'>) =>
    send('POST /api/extensions/prompts', body),
  updatePrompt: (id: string, body: Input<'PUT /api/extensions/prompts/:id'>) =>
    send('PUT /api/extensions/prompts/:id', body, { id }),
  deletePrompt: (id: string) => send('DELETE /api/extensions/prompts/:id', undefined, { id }),
  applyPrompt: (id: string) => send('POST /api/extensions/prompts/:id/apply', undefined, { id }),
  skills: (s?: AbortSignal) => send('GET /api/extensions/skills', undefined, {}, s),
  settings: (s?: AbortSignal) => send('GET /api/settings', undefined, {}, s),
  updateSettings: (body: Input<'PUT /api/settings'>) => send('PUT /api/settings', body),
  backups: (s?: AbortSignal) => send('GET /api/backups', undefined, {}, s),
  restore: (id: string) => send('POST /api/backups/:id/restore', undefined, { id }),
  detectCc: (s?: AbortSignal) => send('GET /api/cc-switch/detect', undefined, {}, s),
  importCc: (body: Input<'POST /api/cc-switch/import'>) => send('POST /api/cc-switch/import', body),
};
