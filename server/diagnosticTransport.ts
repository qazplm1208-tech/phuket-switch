import type { ConnectionStepError, OnlineCheckStepResult } from '../shared/types.js';
import { elapsed, own, redactRecognizable } from './common.js';
import { StreamMetrics } from './streamMetrics.js';

export const diagnosticPrompt = '请仅回复 OK';
export function scrub(value: string, secrets: string[]) {
  for (const secret of secrets) if (secret) value = value.replaceAll(secret, '[已隐藏]');
  return redactRecognizable(value).replace(/sk-[a-z0-9._-]+/gi, '[已隐藏]');
}
export function stepError(code: string, message: string): ConnectionStepError {
  return { code, httpStatus: null, networkCode: null, upstreamType: null, upstreamCode: null, message };
}
const field = (v: unknown) => typeof v === 'string' || typeof v === 'number' ? String(v) : null;
function upstreamDetails(data: unknown, code: string, fallback: string, status: number) {
  const v = own(data), e = own(v.error ?? v.response?.error);
  return { ...stepError(code, field(e.message) || field(v.message) || field(v.reason) || fallback),
    httpStatus: status, upstreamType: field(e.type ?? v.type), upstreamCode: field(e.code ?? v.code) };
}

// Bound buffered JSON and plain-text error bodies; preserve socket errors during reads.
async function readPayload(response: Response) {
  const reader = response.body?.getReader(); if (!reader) return null;
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > 1024 * 1024) { await reader.cancel(); return null; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const text = Buffer.concat(chunks, size).toString('utf8');
  try { return JSON.parse(text) as unknown; } catch { return text; }
}

export async function checkInference(send: typeof fetch, endpoint: string, model: string, headers: Record<string, string>, body: object, secrets: string[]): Promise<OnlineCheckStepResult> {
  const start = performance.now(), signal = AbortSignal.timeout(30_000);
  let error: ConnectionStepError | undefined;
  const metrics = new class extends StreamMetrics {
    override observe(data: unknown, event = '') {
      const v = own(data);
      if (v.error || v.response?.error || v.status === 'failed' || v.type === 'response.failed' || v.type === 'error' || event === 'error') {
        error = upstreamDetails(data, 'UPSTREAM_ERROR', '上游报告推理失败。', 200);
      }
      super.observe(data, event);
    }
  }(start, 8192);
  try {
    const response = await send(endpoint, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal, redirect: 'error' });
    if (!response.ok) {
      const data = await readPayload(response).catch(() => null);
      error = upstreamDetails(data, `HTTP_${response.status}`, typeof data === 'string' && data.trim() || `上游返回 HTTP ${response.status}`, response.status);
    } else {
      if (response.body && /text\/event-stream/i.test(response.headers.get('content-type') ?? '')) {
        const reader = response.body.getReader();
        try {
          while (true) { const { done, value } = await reader.read(); if (done) break; metrics.push(value); }
          metrics.finish();
        } finally { reader.releaseLock(); }
      } else metrics.observe(await readPayload(response));
      if (!error && (metrics.failed || !metrics.text.trim())) error = stepError('INVALID_RESPONSE', '未收到有效的模型回复。');
    }
  } catch (cause) {
    const e = own(cause), code = signal.aborted || e.name === 'TimeoutError' ? 'TIMEOUT' : field(e.cause?.code ?? e.code ?? e.name) || 'NETWORK_ERROR';
    error = { ...stepError(code, field(e.cause?.message ?? e.message) || '网络连接失败。'), networkCode: code };
  }
  // Scrub before truncation, including upstream codes and successful previews.
  const clean = (s: string) => scrub(s, secrets);
  if (error) for (const k of ['message','code','upstreamCode','upstreamType','networkCode'] as const) {
    const v = error[k]; if (v) error[k] = clean(v).slice(0, 1024);
  }
  return { endpoint: clean(endpoint), model: clean(model), status: error ? 'failed' : 'passed', ok: !error, latencyMs: elapsed(start), firstTokenMs: metrics.firstTokenMs,
    ...(error ? { error } : { previewText: clean(metrics.text).slice(0, 256) }) };
}
