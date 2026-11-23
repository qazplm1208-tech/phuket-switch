import { ApiError, own, redactRecognizable, upstreamError } from './common.js';
import { adaptiveFetch, networkTags, readBodyBytes } from './upstreamTransport.js';

export function networkError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  const tags = networkTags(error);
  const has = (pattern: RegExp) => tags.some(tag => pattern.test(tag));
  if (has(/^(TimeoutError|AbortError|ABORT_ERR|ETIMEDOUT|UND_ERR_(CONNECT|HEADERS|BODY)_TIMEOUT)$/)) return new ApiError(502, 'UPSTREAM_TIMEOUT', '连接 PhuketAI 超时，请检查网络连接或本地代理（Clash/v2ray 等）后重试。');
  if (has(/^(ENOTFOUND|EAI_AGAIN)$/)) return new ApiError(502, 'UPSTREAM_DNS', '无法解析域名 ai.pukitcore.com（DNS 错误），请检查网络或代理设置。');
  if (has(/^ECONNREFUSED$/)) return new ApiError(502, 'UPSTREAM_REFUSED', '无法连接 PhuketAI 或本地代理端口（连接被拒绝），请检查代理软件是否运行正常。');
  if (has(/^(CERT_|ERR_TLS_|UNABLE_TO_(?:VERIFY_|GET_ISSUER_CERT)|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN)/)) return new ApiError(502, 'UPSTREAM_TLS', 'TLS 证书校验失败，请检查系统时间是否准确，或检查杀毒软件/代理 HTTPS 拦截设置。');
  if (has(/^(ECONNRESET|EPIPE|UND_ERR_SOCKET)$/)) return new ApiError(502, 'UPSTREAM_RESET', '与 PhuketAI 的连接被中断，请开启/切换网络代理后重试。');
  // Never expose the raw message, cause, proxy URL or arbitrary upstream code.
  const code = tags.find(t => /^(ENETUNREACH|EHOSTUNREACH|ENETDOWN|EADDRNOTAVAIL|EPROTO|ECONNABORTED)$/.test(t));
  return new ApiError(502, 'UPSTREAM_NETWORK', `无法连接 PhuketAI 服务（${code ?? '网络异常'}），请检查网络或代理设置后重试。`);
}

export type Fetch = typeof fetch;
const allowed = [400, 401, 403, 404, 409, 422, 423, 429];

function field(value: unknown) {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

function errorDetails(payload: unknown) {
  const root = own(payload), nested = own(root.error ?? root.response?.error);
  const code = field(nested.code ?? root.code);
  const message = field(nested.message ?? root.message ?? root.detail ?? root.error_description) || (typeof root.error === 'string' ? root.error : '');
  const reason = field(nested.reason ?? root.reason);
  return { code, message, reason };
}

function edgeName(headers?: Headers) {
  const server = headers?.get('server')?.trim() ?? '';
  if (/^cloudflare(?:\/[\d.]+)?$/i.test(server)) return 'Cloudflare';
  if (/^nginx(?:\/[\d.]+)?$/i.test(server)) return 'nginx';
  return '';
}
function localizedMessage(status: number, code: string, message: string, reason: string, headers?: Headers) {
  const haystack = `${code} ${reason} ${message}`.toLowerCase();
  if (/temp[_\s-]?token/.test(haystack) && /expir|invalid|过期|失效/.test(haystack)) return '两步验证已超时，请返回重新输入邮箱和密码。';
  if (/account[_\s-]locked|too[_\s-]many/.test(haystack)) return '登录失败次数过多或账号暂时受限，请稍后再试。';
  if (/email[_\s-]not[_\s-]verified/.test(haystack)) return '该账号邮箱尚未验证，请先在网页端完成验证。';
  if (/totp/.test(haystack)) return '动态验证码不正确或已过期，请重新输入。';
  if (status === 429) return '登录尝试过于频繁，请稍后再试。';
  if (/invalid_credentials|invalid email or password/i.test(haystack)) return '邮箱或密码不正确。';
  if (/account_disabled|user is disabled/i.test(haystack)) return '该账号已被停用，请联系管理员。';
  if (/captcha_required|turnstile_failed/i.test(haystack)) return '站点要求人机验证，请点击「网页窗口登录」完成验证，或在浏览器登录后使用「Token 登录」。';
  if (/user_agreement_required/i.test(haystack)) return '请先确认平台服务协议后再登录。';
  if (!message.trim() && !reason.trim()) {
    if (status === 403 || status === 503) {
      const edge = edgeName(headers);
      return `站点或代理未返回登录结果（HTTP ${status}${edge ? `，${edge}` : ''}），可能需要人机验证。请点击「网页窗口登录」，或在浏览器登录后使用「Token 登录」。如仍失败，请检查代理设置。`;
    }
    if (status === 502) return '上游网关暂时不可用（HTTP 502），请检查网络或代理设置后重试。';
  }
  return redactRecognizable(message || reason || `上游返回 HTTP ${status}。`).slice(0, 4096);
}

export function responseError(status: number, payload?: unknown, headers?: Headers) {
  const { code, message, reason } = errorDetails(payload);
  const safeCode = redactRecognizable(code || 'UPSTREAM_ERROR').slice(0, 256);
  return new ApiError(allowed.includes(status) ? status : 502, safeCode, localizedMessage(status, code, message, reason, headers));
}

export function checkStatus(status: number, payload?: unknown, headers?: Headers) {
  if (status >= 200 && status < 300) return;
  throw responseError(status, payload, headers);
}

export async function readJson(response: Response, limit = 16 * 1024 * 1024): Promise<unknown> {
  if (response.status === 204) return null;
  if (!response.body) throw upstreamError();
  let bytes: Buffer;
  try { bytes = await readBodyBytes(response, limit); } catch (error) { throw networkError(error); }
  if (!bytes.length) return null;
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw new ApiError(502, 'INVALID_UPSTREAM_JSON', '上游服务未返回有效 JSON，请检查网络或代理设置。'); }
}

export async function fetchJsonResponse(url: string | URL, init: RequestInit = {}, send: Fetch = fetch) {
  const deadline = AbortSignal.timeout(25_000);
  const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
  try {
    const response = await adaptiveFetch(url, { ...init, signal, redirect: init.redirect ?? 'follow' }, send);
    if (!response.ok) {
      const payload = await readJson(response).catch(() => null);
      checkStatus(response.status, payload, response.headers);
    }
    return { response, json: await readJson(response) };
  } catch (error) { throw networkError(signal.aborted ? signal.reason : error); }
}
export async function fetchJson(url: string | URL, init: RequestInit = {}, send: Fetch = fetch) {
  return (await fetchJsonResponse(url, init, send)).json;
}
