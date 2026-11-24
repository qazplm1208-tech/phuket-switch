import type { ChatTestRequest, ChatTestResult, GptFastConfig, LocalProbeRequest, LocalProbeResult, Provider, ServiceTier, SpeedCompareRequest, SpeedCompareResult, SpeedCompareSample } from '../shared/types.js';
import type { SwitchDb } from './db.js';
import { bad, elapsed, normalizeV1Base, now, stripV1Beta } from './common.js';
import { readJson } from './httpClient.js';
import { hybridBase, rewriteResponses } from './fastMode.js';
import { providerHeaders } from './phuketClient.js';
import { adaptiveFetch } from './upstreamTransport.js';
import { StreamMetrics } from './streamMetrics.js';

import { pickRecommendedModel, providerModelNames } from '../shared/constants.js';
const selectedModel = (p: Provider, model?: string) => model || p.model || (p.protocol === 'gemini-native' ? pickRecommendedModel(providerModelNames(p), p.protocol) || 'gemini-2.5-pro' : p.claudeModelMap?.defaultModel || p.availableModels?.[0] || (p.protocol === 'anthropic-messages' ? 'claude-sonnet-5-5' : 'gpt-6.2-astra'));
async function measure(p: Provider, body: Record<string, any>, timeout: number, textLimit: number, fallback?: string, geminiModel?: string) {
  const start = performance.now(), metrics = new StreamMetrics(start, textLimit), anthropic = p.protocol === 'anthropic-messages';
  const signal = AbortSignal.timeout(timeout);
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(anthropic ? { 'x-api-key': p.apiKey, 'anthropic-version': '2023-06-01', 'User-Agent': 'claude-cli/2.1.0' } : providerHeaders(p)) };
  const endpoint = geminiModel ? `${stripV1Beta(p.baseUrl)}/v1beta/models/${encodeURIComponent(geminiModel)}:generateContent` : `${normalizeV1Base(p.baseUrl)}/${anthropic ? 'messages' : 'responses'}`;
  let statusCode: number | null = null, error: string | undefined;
  try {
    const send = () => adaptiveFetch(endpoint, { method: 'POST', body: JSON.stringify(body), headers, redirect: 'error', signal });
    let res = await send();
    if (fallback && fallback !== body.model && [502,503].includes(res.status)) { await res.body?.cancel(); body.model = fallback; res = await send(); }
    statusCode = res.status;
    if (!res.ok) { await res.body?.cancel(); error = `Upstream returned HTTP ${res.status}.`; }
    else if (/text\/event-stream/i.test(res.headers.get('content-type') ?? '') && res.body) {
      const reader = res.body.getReader();
      try { for (;;) { const { value, done } = await reader.read(); if (done) break; metrics.push(value); } metrics.finish(); } finally { reader.releaseLock(); }
      if (metrics.failed) error = 'Upstream reported a stream failure.';
    } else { metrics.observe(await readJson(res)); if (metrics.failed) error = 'Upstream reported an inference failure.'; }
  } catch { error = signal.aborted ? 'Request timed out.' : 'Unable to complete the provider request.'; }
  return { metrics, latencyMs: elapsed(start), statusCode, error, effectiveModel: geminiModel ?? String(body.model) };
}
function responses(p: Provider, model: string, input: string, limit: number, cfg?: GptFastConfig, explicit = false) {
  const body = { model, input, max_output_tokens: limit, stream: true, store: false };
  return cfg ? rewriteResponses(body, cfg, p, explicit) : { ...body, service_tier: 'default' };
}
function median(values: number[]) {
  if (!values.length) return null; values.sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2); return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
}
export async function runSpeedCompare(db: SwitchDb, req: SpeedCompareRequest): Promise<SpeedCompareResult> {
  const startedAt = now(), p = db.provider(req.providerId);
  if (p.protocol !== 'openai-responses') throw bad('Speed comparison requires a Responses provider.');
  const preset = req.fastConfig ?? p.codexFastConfig ?? db.state('fastMode');
  const fast: GptFastConfig = { ...preset, enabled: true, serviceTier: preset.enabled && preset.serviceTier !== 'default' ? preset.serviceTier : 'priority' };
  const selected = selectedModel(p, req.model);
  const model = Object.entries(fast.fastModelMap).find(([, suffix]) => selected === suffix)?.[0] ?? selected;
  const timeout = db.state('proxySettings').requestTimeoutMs, samples: SpeedCompareSample[] = [];
  for (let run = 1; run <= (req.runs ?? 1); run++) for (const mode of ['standard','fast'] as const) {
    const body = responses(p, model, req.prompt ?? 'Count from one to ten.', req.maxOutputTokens ?? 128, mode === 'fast' ? fast : undefined, true);
    const { metrics, latencyMs, statusCode, error, effectiveModel } = await measure(p, body, timeout, 256, mode === 'fast' && fast.strategy === 'hybrid' ? model : undefined);
    samples.push({ mode, run, model, effectiveModel, serviceTier: (body.service_tier ?? 'default') as ServiceTier, ok: !error, latencyMs, statusCode, firstTokenMs: metrics.firstTokenMs, outputTokens: metrics.outputTokens, tokensPerSec: metrics.outputTokens !== null && latencyMs > 0 ? 1000 * metrics.outputTokens / latencyMs : null, previewText: metrics.text, ...(error ? { error } : {}) });
  }
  const med = (mode: string) => median(samples.filter(s => s.ok && s.mode === mode).map(s => s.latencyMs));
  const standardMedianMs = med('standard'), fastMedianMs = med('fast');
  return { startedAt, finishedAt: now(), providerId: p.id, providerName: p.name, model, standardMedianMs, fastMedianMs, speedup: standardMedianMs !== null && fastMedianMs ? standardMedianMs / fastMedianMs : null, samples };
}
export async function runChatTest(db: SwitchDb, req: ChatTestRequest): Promise<ChatTestResult> {
  const testedAt = now(), p = db.provider(req.providerId), model = selectedModel(p, req.model), max = req.maxOutputTokens ?? 512;
  const fast = req.fastConfig ?? p.codexFastConfig ?? db.state('fastMode');
  const anthropic = p.protocol === 'anthropic-messages';
  const gemini = p.protocol === 'gemini-native';
  const body: Record<string, any> = gemini ? { contents: [{ role: 'user', parts: [{ text: req.prompt }] }], generationConfig: { maxOutputTokens: max } }
    : anthropic ? { model, max_tokens: max, messages: [{ role: 'user', content: req.prompt }] } : responses(p, model, req.prompt, max, fast, !!req.fastConfig);
  const { metrics, latencyMs, statusCode, error, effectiveModel } = await measure(p, body, db.state('proxySettings').requestTimeoutMs, 512 * 1024, !anthropic && !gemini ? hybridBase(model, fast) : undefined, gemini ? model : undefined);
  return { providerId: p.id, testedAt, model, protocol: p.protocol, effectiveModel, text: metrics.text, ok: !error, statusCode, latencyMs, ...(body.service_tier ? { serviceTier: body.service_tier } : {}), ...(metrics.inputTokens === null ? {} : { inputTokens: metrics.inputTokens }), ...(metrics.outputTokens === null ? {} : { outputTokens: metrics.outputTokens }), ...(error ? { error } : {}) };
}
export async function runLocalProbe(db: SwitchDb, req: LocalProbeRequest): Promise<LocalProbeResult> {
  const p = db.provider(req.providerId), start = performance.now(), testedAt = now(), model = selectedModel(p, req.model);
  let statusCode: number | null = null;
  const endpoint = p.protocol === 'gemini-native' ? `${stripV1Beta(p.baseUrl)}/v1beta/models` : `${normalizeV1Base(p.baseUrl)}/models`;
  try { const res = await adaptiveFetch(endpoint, { headers: providerHeaders(p), signal: AbortSignal.timeout(Math.min(10000, db.state('proxySettings').requestTimeoutMs)), redirect: 'error' }); statusCode = res.status; await res.body?.cancel(); } catch { /* report as a measurement, not a management error */ }
  const ok = statusCode !== null && statusCode >= 200 && statusCode < 300;
  return { providerId: p.id, model, protocol: p.protocol, testedAt, latencyMs: elapsed(start), statusCode, ok, ...(!ok ? { error: statusCode ? `Upstream returned HTTP ${statusCode}.` : 'Connection failed.' } : {}) };
}
