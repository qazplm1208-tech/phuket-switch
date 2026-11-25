import http from 'node:http';
import { adaptiveFetch } from './upstreamTransport.js';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import express from 'express';
import type { Request, Response as LocalResponse } from 'express';
import { isAstraModel, isOnlyAstraGroup, isUltraFastGroup, providerModelNames } from '../shared/constants.js';
import type { AppType, GptFastConfig, Provider, ProxyRequestLog, ProxySettings, ProxyStatus, ProxyTakeoverResult, ServiceTier } from '../shared/types.js';
import type { SwitchDb } from './db.js';
import { ApiError, bad, conflict, elapsed, isRecord, loopbackRequest, notApplied, now, redactRecognizable, stripV1, stripV1Beta } from './common.js';
import { applyProvider, desktopModelNames, restoreBackup } from './configSync.js';
import { astraDedicatedModels, fallbackCodexModels, hybridBase, missingAstraOnlyMessage, missingUltraFastMessage, parseVirtualSpeedModel, resolveAstraOnlyProvider, resolveRequestSpeedMode, resolveUltraFastProvider, rewriteResponses, speedMenuModels } from './fastMode.js';
import { readJson } from './httpClient.js';
import { StreamMetrics } from './streamMetrics.js';
import { anthropicToResponsesRequest, responsesToAnthropicRequest, responsesToAnthropicResponse, anthropicToResponsesResponse, streamResponsesToAnthropicSse, streamAnthropicToResponsesSse } from './protocolTranslator.js';

const isClaude = (route: string) => route === '/v1/messages' || route === '/v1/messages/count_tokens';
type GeminiApp = 'gemini' | 'antigravity';
const geminiRoute = /^\/(?:(gemini|antigravity)\/)?v1beta\/.+$/;
function googleError(err: ApiError) {
  const statuses: Record<number, string> = { 400: 'INVALID_ARGUMENT', 401: 'UNAUTHENTICATED', 403: 'PERMISSION_DENIED', 404: 'NOT_FOUND', 413: 'RESOURCE_EXHAUSTED', 429: 'RESOURCE_EXHAUSTED', 499: 'CANCELLED', 502: 'UNAVAILABLE', 503: 'UNAVAILABLE', 504: 'DEADLINE_EXCEEDED' };
  return { error: { code: err.status, message: err.message, status: statuses[err.status] ?? 'INTERNAL' } };
}
function geminiCandidates(all: Provider[], app: GeminiApp, bare: boolean, failover: boolean) {
  const native = all.filter(p => p.protocol === 'gemini-native');
  const first = native.find(p => p.appType === app && p.isCurrent) ?? (bare ? native.find(p => p.appType === 'antigravity' && p.isCurrent) : undefined);
  const queue = failover ? native.filter(p => p.inFailoverQueue && p.id !== first?.id) : [];
  return [...(first ? [first] : []), ...queue.filter(p => p.appType === app), ...queue.filter(p => p.appType !== app)];
}
type AnthropicApp = 'claude' | 'claude-desktop';
const desktopPrefix = '/claude-desktop';
const isDesktopPath = (route: string) => route.startsWith(`${desktopPrefix}/`);
const inferenceError = (err: ApiError, anthropic: boolean) => anthropic
  ? { type: 'error', error: { type: err.status === 400 ? 'invalid_request_error' : 'api_error', message: err.message } }
  : { error: { code: err.code, message: err.message } };
const retryable = (status: number) => [502, 503, 529].includes(status);
function claudeModel(model: string, p: Provider) {
  const map = p.claudeModelMap;
  const alias = /opus|sonnet|haiku/i.exec(model)?.[0].toLowerCase() as 'opus' | 'sonnet' | 'haiku' | undefined;
  return (alias && map?.[alias]) || (model && model !== 'default' ? model : map?.defaultModel) || p.model || model;
}
function modelList(names: string[], upstream?: Record<string, any>) {
  const byId = new Map<string, Record<string, any>>();
  const add = (id: string, fields = {}) => byId.set(id, { id, object: 'model', owned_by: 'phuket-switch', created: 0, type: 'model', display_name: id, created_at: '1970-01-01T00:00:00Z', ...fields });
  for (const m of Array.isArray(upstream?.data) ? upstream.data : []) if (typeof m?.id === 'string') add(m.id, m);
  for (const id of names) if (!byId.has(id)) add(id);
  const data = [...byId.values()];
  return { ...upstream, object: 'list', data, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null, has_more: upstream?.has_more ?? false };
}
export class ProxyServer {
  private server: http.Server | null = null;
  private startedAt: string | null = null;
  private count = 0;
  private lastError?: string;
  private queue: Promise<unknown> = Promise.resolve();
  private pending = new Set<Promise<void>>();
  constructor(private readonly db: SwitchDb) {}
  getStatus(): ProxyStatus {
    const settings = this.db.state('proxySettings'), running = !!this.server?.listening;
    return { running, settings, takeover: this.db.state('proxyTakeover'), baseUrl: running ? `http://${settings.host}:${settings.port}` : null, requestCount: this.count, startedAt: this.startedAt, ...(this.lastError ? { lastError: this.lastError } : {}) };
  }
  configRoot(app: AppType) {
    const status = this.getStatus(); return status.takeover[app] ? `http://${status.settings.host}:${status.settings.port}` : undefined;
  }
  private exclusive<T>(fn: () => Promise<T>): Promise<T> { const job = this.queue.then(fn, fn); this.queue = job.catch(() => {}); return job; }
  start() { return this.exclusive(async () => { await this.listen(); return this.getStatus(); }); }
  stop() { return this.exclusive(async () => { await this.close(); return this.getStatus(); }); }
  private async listen() {
    if (this.server?.listening) return;
    const cfg = this.db.state('proxySettings');
    const app = express(); app.disable('x-powered-by'); app.enable('case sensitive routing');
    app.use((req, res, next) => {
      res.set('Cache-Control', 'no-store');
      if (!loopbackRequest(req)) return next(new ApiError(403, 'LOOPBACK_ONLY', 'Local clients only.'));
      next();
    });
    app.use(express.json({ limit: '16mb' }));
    const handler = (req: Request, res: LocalResponse) => {
      const job = this.forward(req, res);
      this.pending.add(job); void job.finally(() => this.pending.delete(job)).catch(() => {}); return job;
    };
    app.post(['/v1/messages','/v1/messages/count_tokens','/claude-desktop/v1/messages','/claude-desktop/v1/messages/count_tokens','/v1/responses','/v1/chat/completions'], handler);
    app.all(geminiRoute, handler);
    app.get(['/v1/models','/claude-desktop/v1/models'], handler);
    app.use((_req, _res, next) => next(new ApiError(404, 'NOT_FOUND', 'Unknown inference route.')));
    const errors: express.ErrorRequestHandler = (err, req, res, next) => {
      if (res.headersSent) return next(err);
      const failure = err instanceof ApiError ? err : new ApiError(err.status === 413 ? 413 : 400, 'INVALID_REQUEST', 'Invalid inference request.');
      res.status(failure.status).json(geminiRoute.test(req.path) ? googleError(failure) : inferenceError(failure, isDesktopPath(req.path) || isClaude(req.path)));
    };
    app.use(errors);
    const s = http.createServer(app);
    try { await new Promise<void>((resolve, reject) => { s.once('error', reject); s.listen(cfg.port, cfg.host, () => { s.off('error', reject); resolve(); }); }); }
    catch { this.lastError = 'Unable to bind the loopback proxy port.'; throw conflict(this.lastError); }
    s.on('error', () => { this.lastError = 'Proxy listener error.'; });
    this.server = s; this.startedAt = now(); this.count = 0; this.lastError = undefined;
  }
  private async close() {
    if (!this.server) return;
    const s = this.server;
    const closed = new Promise<void>((resolve, reject) => s.close(err => err ? reject(err) : resolve()));
    s.closeAllConnections(); await closed; await Promise.allSettled(this.pending);
    this.server = null; this.startedAt = null;
  }
  updateSettings(settings: ProxySettings) {
    return this.exclusive(async () => {
      const old = this.getStatus(), rebind = old.settings.port !== settings.port;
      if (rebind && Object.values(old.takeover).some(Boolean)) throw conflict('Disable takeover before changing the proxy port.');
      if (rebind && old.running) await this.close();
      this.db.setState('proxySettings', settings);
      if (rebind && old.running) try { await this.listen(); } catch (e) { this.db.setState('proxySettings', old.settings); await this.listen(); throw e; }
      return this.getStatus();
    });
  }
  takeover(appType: AppType, enable: boolean, fast?: GptFastConfig): Promise<ProxyTakeoverResult> {
    return this.exclusive(async () => {
      const status = this.getStatus(), originals = this.db.state('proxyOriginalConfigs');
      let system = notApplied() as ProxyTakeoverResult['system'];
      if (status.takeover[appType] === enable) {
        // A one-click menu refresh must use the existing proxy URL and preserve its original undo snapshot.
        if (enable && fast && appType === 'codex') {
          const p = this.db.current('codex');
          if (p) { await this.listen(); system = applyProvider(this.db, p, { fast, proxyRoot: this.getStatus().baseUrl! }); }
        }
        return { proxy: this.getStatus(), system };
      }
      if (enable) {
        const p = this.db.current(appType); if (!p) throw conflict('Select a current provider before enabling takeover.');
        await this.listen();
        system = applyProvider(this.db, p, { fast, proxyRoot: this.getStatus().baseUrl!, takeover: true });
        originals[appType] = { providerId: p.id, backupId: system.backupId };
      } else {
        const original = originals[appType];
        const current = this.db.current(appType);
        if (original?.backupId) system = current && current.id !== original.providerId
          ? applyProvider(this.db, current) // A different provider was selected during takeover.
          : restoreBackup(this.db, original.backupId, current);
        delete originals[appType];
      }
      this.db.transaction(() => { this.db.setState('proxyOriginalConfigs', originals); this.db.setState('proxyTakeover', { ...status.takeover, [appType]: enable }); });
      return { proxy: this.getStatus(), system };
    });
  }
  private candidates(route: string, model: string, failover: boolean, all: Provider[], anthropicApp: AnthropicApp, target?: Provider, preferCodex = false) {
    if (target) return [target, ...(failover && target.protocol === 'anthropic-messages'
      ? all.filter(p => p.id !== target.id && p.protocol === target.protocol && p.inFailoverQueue) : [])];
    if (isClaude(route) || anthropicApp === 'claude-desktop') {
      const sameApp = all.filter(p => p.protocol === 'anthropic-messages' && p.appType === anthropicApp);
      const first = sameApp.find(p => p.isCurrent);
      return [...(first ? [first] : []), ...(failover ? sameApp.filter(p => p.inFailoverQueue && p.id !== first?.id) : []),
        ...(failover && anthropicApp === 'claude-desktop' ? all.filter(p => p.appType !== anthropicApp && p.protocol === 'anthropic-messages' && p.inFailoverQueue) : [])];
    }
    const providers = all.filter(p => ['codex','gpt-native'].includes(p.appType) && p.protocol === 'openai-responses');
    const native = !preferCodex && route === '/v1/responses' && model ? providers.filter(p => p.appType === 'gpt-native' && (p.model === model || p.availableModels?.includes(model))) : [];
    const first = native.find(p => p.isCurrent) ?? native[0] ?? providers.find(p => p.isCurrent && p.appType === 'codex') ?? providers.find(p => p.isCurrent);
    return [...(first ? [first] : []), ...(failover ? providers.filter(p => p.inFailoverQueue && p.id !== first?.id) : [])];
  }
  private async forward(req: Request, res: LocalResponse) {
    const start = performance.now(), settings = this.db.state('proxySettings'), isDesktop = isDesktopPath(req.path);
    const native = geminiRoute.exec(req.path), gemini = !!native;
    const geminiApp: GeminiApp = native?.[1] === 'antigravity' ? 'antigravity' : 'gemini';
    const prefix = native?.[1] ? `/${native[1]}` : isDesktop ? desktopPrefix : '';
    const route = req.path.slice(prefix.length).replace(/\/$/, '');
    let upstreamOriginalUrl = req.originalUrl.slice(prefix.length);
    if (native) {
      const url = new URL(upstreamOriginalUrl, 'http://localhost');
      if (!url.pathname.startsWith('/v1beta/')) throw bad('Invalid Gemini API path.');
      url.searchParams.delete('key'); upstreamOriginalUrl = url.pathname + url.search;
      if (req.method !== 'GET' && req.method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Expected GET or POST.');
    }
    const anthropicApp: AnthropicApp = isDesktop ? 'claude-desktop' : 'claude';
    const anthropic = isDesktop || isClaude(route), responses = route === '/v1/responses', gptRequest = responses || route === '/v1/chat/completions';
    const raw = req.method === 'GET' ? {} : req.body;
    if (!isRecord(raw) || raw.model !== undefined && (typeof raw.model !== 'string' || raw.model.length > 256 || /[\r\n]/.test(raw.model))) throw bad('Expected a JSON object and a valid model name.');
    const virtual = gptRequest ? parseVirtualSpeedModel(raw.model ?? '') : { baseModel: String(raw.model ?? '') };
    const model = gemini ? decodeURIComponent(/^\/v1beta\/models\/([^/:]+)/.exec(route)?.[1] ?? '') : virtual.baseModel;
    let input = virtual.forcedMode ? { ...raw, model } : raw;
    if (virtual.forcedMode && (!model || parseVirtualSpeedModel(model).forcedMode)) throw bad('Invalid virtual speed model.');
    const all = this.db.providers(), rules = this.db.state('modelRoutes');
    const client = gemini ? geminiApp : anthropic ? anthropicApp : 'codex', sourceProtocol = gemini ? 'gemini-native' : anthropic ? 'anthropic-messages' : 'openai-responses';
    const discovery = route === '/v1/models';
    const enabled = rules.filter(r => r.enabled && r.sourceClient === client && all.some(p => p.id === r.targetProviderId && p.protocol !== 'gemini-native'));
    const rule = (anthropic || responses) ? enabled.find(r => r.sourceModel === model) ?? enabled.find(r => r.sourceModel === '*') : undefined;
    const target = rule && all.find(p => p.id === rule.targetProviderId);
    const globalFast = this.db.state('fastMode'), currentCodex = all.find(p => p.isCurrent && p.appType === 'codex');
    const codexFast = currentCodex?.codexFastConfig ?? globalFast;
    const dedicated = resolveUltraFastProvider(all, currentCodex, codexFast);
    const astraDedicated = resolveAstraOnlyProvider(all, currentCodex, codexFast);
    let list: Provider[] = [];
    let forcedMode = virtual.forcedMode;
    const localNames: string[] = [];
    if (discovery) {
      const active = all.filter(p => p.isCurrent);
      if (isDesktop) {
        const desktop = active.find(p => p.appType === 'claude-desktop');
        localNames.push(...(desktop ? [desktop] : active.filter(p => p.protocol === 'anthropic-messages')).flatMap(desktopModelNames));
      } else {
        const astraModels = astraDedicatedModels(astraDedicated);
        localNames.push(...[...active.flatMap(p => providerModelNames(p)), ...astraModels, ...rules.filter(r => r.enabled && r.sourceModel !== '*').map(r => r.sourceModel)].filter(m => !parseVirtualSpeedModel(m).forcedMode));
        if (currentCodex && this.db.state('proxyTakeover').codex && globalFast.catalogSpeedVariants !== false && codexFast.catalogSpeedVariants !== false) {
          const normal = providerModelNames(currentCodex), routed = new Set(enabled.map(r => r.sourceModel));
          const menu = speedMenuModels([...(normal.length ? normal : fallbackCodexModels), ...astraModels], true, dedicated);
          localNames.push(...menu.filter(row => row.mode && !routed.has(row.baseModel)).map(row => row.slug));
        }
      }
    }
    const log: ProxyRequestLog = { id: randomUUID(), createdAt: now(), protocol: sourceProtocol, appType: client, model, effectiveModel: model, providerId: null, statusCode: 503, latencyMs: 0, failoverCount: 0, fastFallback: false };
    this.count++;
    const disconnected = new AbortController(), timeout = AbortSignal.timeout(settings.requestTimeoutMs);
    const signal = AbortSignal.any([disconnected.signal, timeout]);
    const abort = () => { if (!res.writableEnded) disconnected.abort(); };
    res.on('close', abort);
    const metrics = new StreamMetrics(start);
    try {
      if (gemini) list = geminiCandidates(all, geminiApp, !native?.[1], settings.failoverEnabled);
      else if (gptRequest && !rule) {
        forcedMode = virtual.forcedMode ?? resolveRequestSpeedMode(input.service_tier, codexFast);
        if (forcedMode === 'ultrafast') {
          if (!dedicated) throw new ApiError(503, 'ULTRAFAST_PROVIDER_MISSING', missingUltraFastMessage);
          list = [dedicated]; // Never fail over to a normal group with an UltraFast tier.
        } else {
          // Exclude dedicated keys even from normal failover, unless explicitly selected as current Codex.
          const requestedModel = model || currentCodex?.model || '';
          const normal = all.filter(p => p === currentCodex || (p.id !== codexFast.ultraFastProviderId && !isUltraFastGroup(p) && p.id !== codexFast.astraOnlyProviderId && !isOnlyAstraGroup(p)));
          list = this.candidates(route, model, settings.failoverEnabled, normal, anthropicApp, undefined, virtual.forcedMode === 'fast');
          if (codexFast.routeAstraToOnlyAstra && isAstraModel(requestedModel)) {
            if (!astraDedicated) throw new ApiError(503, 'ASTRA_ONLY_PROVIDER_MISSING', missingAstraOnlyMessage);
            if (!model) input = { ...input, model: requestedModel };
            list = [astraDedicated, ...(settings.failoverEnabled ? list.filter(p => p.id !== astraDedicated.id) : [])];
          }
        }
      } else list = this.candidates(route, model, settings.failoverEnabled, all, anthropicApp, target);
      if (!list.length && discovery) { log.statusCode = 200; res.json(modelList(localNames)); return; }
      if (!list.length) throw new ApiError(503, 'NO_PROVIDER', 'No active provider is available for this protocol.');
      for (const [i, p] of list.entries()) {
        // A virtual selection requests this exact base model, not a legacy -fast substitution.
        const preset = p.codexFastConfig ?? globalFast;
        const cfg = virtual.forcedMode ? { ...preset, strategy: 'tier_only' as const } : preset;
        const toClaude = p.protocol === 'anthropic-messages';
        const translated = !!target && p.protocol !== sourceProtocol;
        const modelOnPath = gemini ? model : undefined;
        const baseModel = modelOnPath ?? (target ? rule!.targetModel : model || p.model || '');
        Object.assign(log, { providerId: p.id, providerName: p.name, appType: anthropic || target || native?.[1] ? client : p.appType, protocol: p.protocol, translatedFrom: translated ? sourceProtocol : undefined, failoverCount: i });
        if (translated && route === '/v1/messages/count_tokens') {
          log.statusCode = 200; log.effectiveModel = baseModel;
          const prompt = JSON.stringify({ system: input.system, messages: input.messages, tools: input.tools });
          res.json({ input_tokens: Math.max(1, Math.ceil(Buffer.byteLength(prompt) / 4)) }); return;
        }
        const routedModel = target && !i ? baseModel : claudeModel(baseModel, p);
        const body = translated ? (toClaude ? responsesToAnthropicRequest(input, routedModel) : anthropicToResponsesRequest(input, baseModel, p, cfg))
          : gptRequest ? rewriteResponses(target ? { ...input, model: baseModel } : input, cfg, p, !!virtual.forcedMode || forcedMode === 'ultrafast', forcedMode)
          : anthropic ? { ...input, model: target ? routedModel : claudeModel(model, p) } : { ...input };
        const path = translated ? (toClaude ? '/v1/messages' : '/v1/responses') : upstreamOriginalUrl;
        const url = `${gemini ? stripV1Beta(p.baseUrl) : stripV1(p.baseUrl)}${path}`;
        const endpoint = new URL(url);
        if (['localhost','127.0.0.1','[::1]'].includes(endpoint.hostname) && Number(endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80)) === settings.port) throw conflict('A provider must not point back to the proxy.');
        const headers: Record<string, string> = toClaude ? {
          'x-api-key': p.apiKey, 'anthropic-version': (!translated && req.get('anthropic-version')) || '2023-06-01',
          ...(!translated && req.get('user-agent') ? { 'user-agent': req.get('user-agent')! } : {}),
          ...(translated ? { 'user-agent': 'claude-cli/2.1.0 (external, cli)' } : req.get('anthropic-beta') ? { 'anthropic-beta': req.get('anthropic-beta')! } : {}),
        } : { Authorization: `Bearer ${p.apiKey}`, ...(gemini ? { 'x-goog-api-key': p.apiKey } : {}) };
        if (req.method !== 'GET') headers['content-type'] = req.get('content-type') || 'application/json';
        if (req.get('accept')) headers.accept = req.get('accept')!;
        if (translated) headers.accept = input.stream ? 'text/event-stream' : 'application/json';
        const retryModel = !toClaude && (gptRequest || translated) ? hybridBase(baseModel, cfg, resolveRequestSpeedMode(body.service_tier, cfg)) : undefined;
        for (;;) {
          log.effectiveModel = modelOnPath ?? (body.model || baseModel); log.serviceTier = ['default','auto','priority','fast','ultrafast','flex'].includes(body.service_tier) ? body.service_tier as ServiceTier : undefined;
          let upstream: Response;
          try { upstream = await adaptiveFetch(url, { method: req.method, headers, body: req.method === 'GET' ? undefined : JSON.stringify(body), signal, redirect: 'error' }); }
          catch {
            if (!signal.aborted && i + 1 < list.length) break;
            if (discovery && localNames.length && !disconnected.signal.aborted) { log.statusCode = 200; res.json(modelList(localNames)); return; }
            throw new ApiError(502, 'UPSTREAM_ERROR', 'Unable to reach the provider.');
          }
          if (retryModel && body.model !== retryModel && [502,503].includes(upstream.status)) {
            await upstream.body?.cancel(); body.model = retryModel; log.fastFallback = true; continue;
          }
          if (retryable(upstream.status) && i + 1 < list.length) { await upstream.body?.cancel(); break; }
          if (discovery && (upstream.ok || localNames.length)) {
            const value = upstream.ok ? await readJson(upstream) : await upstream.body?.cancel();
            log.statusCode = 200; res.json(modelList(localNames, isRecord(value) ? value : undefined)); return;
          }
          log.statusCode = upstream.status;
          res.status(upstream.status);
          for (const k of ['retry-after','request-id','x-request-id']) { const v = upstream.headers.get(k); if (v) res.setHeader(k, v); }
          const contentType = upstream.headers.get('content-type') || '', isSse = /text\/event-stream/i.test(contentType);
          if ((gemini || anthropic || translated) && !upstream.ok) {
            await upstream.body?.cancel(); throw new ApiError(upstream.status, 'UPSTREAM_ERROR', `Provider returned HTTP ${upstream.status}.`);
          }
          if (translated) {
            if (isSse && upstream.body) {
              const stream = toClaude ? streamAnthropicToResponsesSse : streamResponsesToAnthropicSse;
              await stream(upstream.body, res, model, m => {
                metrics.firstTokenMs = m.ttftMs; metrics.totalTokens = m.totalTokens;
                if (m.failed) { log.error = 'Provider stream failed.'; log.statusCode = 502; }
              }, { start, signal });
            } else {
              const value = await readJson(upstream);
              if (!isRecord(value)) throw new ApiError(502, 'UPSTREAM_ERROR', 'Expected a provider JSON response.');
              const result = toClaude ? anthropicToResponsesResponse(value, model) : responsesToAnthropicResponse(value, model);
              metrics.firstByteMs = elapsed(start); metrics.observe(result); res.json(result);
            }
            return;
          }
          if (contentType) res.setHeader('Content-Type', contentType);
          if (isSse) res.setHeader('X-Accel-Buffering', 'no');
          res.flushHeaders();
          const reader = upstream.body?.getReader(); const json: Uint8Array[] = []; let size = 0;
          if (reader) try {
            for (;;) {
              const { value, done } = await reader.read(); if (done) break;
              metrics.firstByteMs ??= elapsed(start);
              if (isSse) metrics.push(value); else if ((size += value.length) <= 256 * 1024) json.push(value);
              if (!res.write(value)) await once(res, 'drain', { signal });
            }
          } finally { reader.releaseLock(); }
          if (isSse) metrics.finish(); else if (size && size <= 256 * 1024) try { metrics.observe(JSON.parse(Buffer.concat(json).toString('utf8'))); } catch { /* opaque upstream payload */ }
          res.end(); return;
        }
      }
      throw new ApiError(502, 'UPSTREAM_ERROR', 'No provider could complete this request.');
    } catch (e) {
      const err = disconnected.signal.aborted ? new ApiError(499, 'CLIENT_CLOSED', 'Client disconnected.') : timeout.aborted ? new ApiError(504, 'TIMEOUT', 'Provider request timed out.') : e instanceof ApiError ? e : new ApiError(502, 'UPSTREAM_ERROR', 'Provider stream failed.');
      log.error = err.message; log.statusCode = err.status; disconnected.abort();
      if (!res.headersSent && !res.destroyed) {
        res.status(err.status).json(gemini ? googleError(err) : inferenceError(err, anthropic || log.translatedFrom === 'anthropic-messages'));
      } else if (!res.writableEnded) res.destroy();
    } finally {
      res.off('close', abort);
      if (settings.logRequests) {
        const safe = (v: string) => all.reduce((text, p) => p.apiKey ? text.replaceAll(p.apiKey, '[REDACTED]') : text, redactRecognizable(v));
        log.model = safe(log.model); log.effectiveModel = safe(log.effectiveModel); if (log.providerName) log.providerName = safe(log.providerName);
        this.db.addLog({ ...log, latencyMs: elapsed(start), ttftMs: metrics.firstTokenMs ?? metrics.firstByteMs, totalTokens: metrics.totalTokens });
      }
    }
  }
}
