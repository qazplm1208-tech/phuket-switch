import { existsSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export const bad = (message: string) => new ApiError(400, 'INVALID_REQUEST', message);
export const missing = (resource: string) => new ApiError(404, 'NOT_FOUND', `${resource} not found.`);
export const conflict = (message: string) => new ApiError(409, 'CONFLICT', message);
export const upstreamError = () => new ApiError(502, 'UPSTREAM_ERROR', '上游服务未返回有效数据，请检查网络或代理设置后重试。');
export const normalizeLoginEmail = (value: string) => value.replace(/\uff20/g, '@').replace(/[\u0000-\u001f\u007f\u00a0\u200b-\u200d\u2060\u3000\ufeff]/g, '').trim();
export const normalizeLoginPassword = (value: string) => value.replace(/[\r\n\u200b-\u200d\u2060\ufeff]/g, '');
export function normalizeLoginToken(value: string) {
  let token = value.replace(/[\u0000-\u0008\u000e-\u001f\u007f\u200b-\u200d\u2060\ufeff]/g, '').trim();
  for (let i = 0; i < 8; i++) {
    const next = token.replace(/^(["'`])([\s\S]*)\1$/, '$2').trim().replace(/^(?:auth_token|access_token)\s*=\s*/i, '').replace(/^Bearer(?:\s+|$)/i, '').trim();
    if (next === token) break;
    token = next;
  }
  return token.replace(/[\t-\r]/g, '').trim();
}
export const now = () => new Date().toISOString();
export const elapsed = (start: number) => Math.max(0, Math.round(performance.now() - start));
export const getUserHome = () => {
  const override = process.env.PHUKET_SWITCH_USER_HOME;
  if (override !== undefined && !override.trim()) throw conflict('The isolated home directory is empty.');
  return path.resolve(override ?? os.homedir());
};

// Also check the real path of the nearest existing ancestor (junctions on Windows).
export function assertNotCcSwitch(file: string) {
  const forbidden = /(?:^|[\\/])\.cc-switch(?:[\\/]|$)/i;
  let ancestor = path.resolve(file);
  while (!existsSync(ancestor) && ancestor !== path.dirname(ancestor)) ancestor = path.dirname(ancestor);
  if (forbidden.test(path.resolve(file)) || forbidden.test(realpathSync.native(ancestor))) {
    throw conflict('CC-Switch storage is read-only.');
  }
}
export function getDataDir() {
  const dir = path.resolve(process.env.PHUKET_SWITCH_HOME || path.join(getUserHome(), '.phuket-switch'));
  assertNotCcSwitch(dir);
  return dir;
}
export const stripV1 = (url: string) => url.replace(/\/+$/, '').replace(/\/v1$/i, '');
export const stripV1Beta = (url: string) => url.replace(/\/+$/, '').replace(/\/v1beta$/i, '');
export const normalizeV1Base = (url: string) => `${stripV1(url)}/v1`;
export function httpBase(value: string) {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) && !url.username && !url.password && !url.search && !url.hash && !/[\s\\]/.test(value);
  } catch { return false; }
}
export const isRecord = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
export const own = (value: unknown): Record<string, any> => isRecord(value) ? value : {};
export function pick<T extends object>(value: unknown, fields: readonly (keyof T)[]): T {
  const record = own(value);
  return Object.fromEntries(fields.filter(k => Object.hasOwn(record, k)).map(k => [k, record[k as string]])) as T;
}
export const asNumber = (value: unknown): number | null => (typeof value === 'number' || typeof value === 'string' && value.trim() !== '') && Number.isFinite(Number(value)) ? Number(value) : null;
export const cacheHitRatePct = (cached: number, input: number) => input > 0 ? Math.round(1000 * Math.min(cached, input) / input) / 10 : 0;
export const secretField = (name: string) => /key|token|authorization|auth_token|password|passwd|secret|credential|cookie/i.test(name);
export const redactRecognizable = (text: string) => text.replace(/rt_[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{12,}|\bsk-[A-Za-z0-9_-]+|\bccs-[A-Za-z0-9_-]{8,}|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|\bBearer\s+[^\s,"'\\]+/gi, '[REDACTED]');
export function loopbackRequest(req: IncomingMessage) {
  const host = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i;
  if (!host.test(req.headers.host ?? '') || req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try { const u = new URL(origin); return /^https?:$/.test(u.protocol) && host.test(u.host); } catch { return false; }
}
export const notApplied = () => ({ applied: false, backupId: null, changedPaths: [] as string[] });
