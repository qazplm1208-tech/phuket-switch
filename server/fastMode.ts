import { effectiveSpeedMode, isSpeedVariantCandidateModel, isUltraFastGroup, sortModelsNewestFirst, VIRTUAL_FAST_SUFFIX, VIRTUAL_ULTRAFAST_SUFFIX } from '../shared/constants.js';
import type { GptFastConfig, Provider, SpeedMode } from '../shared/types.js';
export { effectiveSpeedMode };
export const fallbackCodexModels = ['gpt-6.2-astra', 'gpt-6.2-sol', 'gpt-6.1-terra'];

export function parseVirtualSpeedModel(model: string): { baseModel: string; forcedMode?: SpeedMode } {
  if (model.endsWith(VIRTUAL_ULTRAFAST_SUFFIX)) return { baseModel: model.slice(0, -VIRTUAL_ULTRAFAST_SUFFIX.length), forcedMode: 'ultrafast' };
  if (model.endsWith(VIRTUAL_FAST_SUFFIX)) return { baseModel: model.slice(0, -VIRTUAL_FAST_SUFFIX.length), forcedMode: 'fast' };
  return { baseModel: model };
}

/** One ordered model list for the Codex catalog and proxy discovery; reserve virtual suffixes for local use. */
export function speedMenuModels(native: string[], variants: boolean, dedicated?: Provider | null) {
  const bases = new Set(native.map(m => m.trim()).filter(m => m && !parseVirtualSpeedModel(m).forcedMode));
  const rows: { slug: string; baseModel: string; mode?: 'fast' | 'ultrafast' }[] = [];
  if (!variants) {
    for (const baseModel of bases) rows.push({ slug: baseModel, baseModel });
    return rows;
  }
  const ultraModels = new Set(sortModelsNewestFirst(dedicated?.availableModels?.length ? dedicated.availableModels : dedicated?.model ? [dedicated.model] : []));
  const addUltra = (baseModel: string) => rows.push({ baseModel, slug: baseModel + VIRTUAL_ULTRAFAST_SUFFIX, mode: 'ultrafast' });
  for (const baseModel of sortModelsNewestFirst([...bases])) {
    rows.push({ slug: baseModel, baseModel });
    if (!isSpeedVariantCandidateModel(baseModel)) continue;
    rows.push({ baseModel, slug: baseModel + VIRTUAL_FAST_SUFFIX, mode: 'fast' });
    if (dedicated && (!ultraModels.size || ultraModels.has(baseModel))) addUltra(baseModel);
  }
  for (const model of ultraModels) if (!bases.has(model) && isSpeedVariantCandidateModel(model)) addUltra(model);
  return rows;
}

export function resolveRequestSpeedMode(inputTier: unknown, cfg: GptFastConfig): SpeedMode {
  switch (typeof inputTier === 'string' ? inputTier.trim().toLowerCase() : '') {
    case 'ultrafast': return 'ultrafast';
    case 'priority': case 'fast': return 'fast';
    case 'default': case 'standard': return 'standard';
    default: return cfg.respectClientServiceTier ? 'standard' : effectiveSpeedMode(cfg);
  }
}
export const missingUltraFastMessage = '未配置 UltraFast 专属供应商（Pro500 ultrafast），请先在 Phuket Switch 绑定 UltraFast 分组。';
export function resolveUltraFastProvider(all: Provider[], current: Provider | null | undefined, cfg: GptFastConfig) {
  const bound = cfg.ultraFastProviderId && all.find(p => p.id === cfg.ultraFastProviderId && p.protocol === 'openai-responses');
  if (bound) return bound;
  if (current?.protocol === 'openai-responses' && isUltraFastGroup(current)) return current;
  return all.find(p => (p.appType === 'codex' || p.appType === 'gpt-native') && p.protocol === 'openai-responses' && isUltraFastGroup(p));
}

export function fastModel(model: string, config: GptFastConfig, mode = effectiveSpeedMode(config)) {
  return mode === 'fast' && config.strategy !== 'tier_only' && Object.hasOwn(config.fastModelMap, model) ? config.fastModelMap[model] : model;
}
export const fastTier = (c: GptFastConfig, mode = effectiveSpeedMode(c)) => mode === 'fast' ? 'priority' : mode === 'ultrafast' ? 'ultrafast' : 'default';
export const codexConfigTier = (c: GptFastConfig) => { const mode = effectiveSpeedMode(c); return mode === 'standard' ? 'default' : mode; };
export function hybridBase(model: string, config: GptFastConfig, mode = effectiveSpeedMode(config)) {
  if (mode !== 'fast' || config.strategy !== 'hybrid') return undefined;
  if (Object.hasOwn(config.fastModelMap, model)) return config.fastModelMap[model] === model ? undefined : model;
  // Codex may already have selected the injected suffix slug from its on-disk catalog.
  return Object.entries(config.fastModelMap).find(([, suffix]) => suffix === model)?.[0];
}
export function rewriteResponses(input: Record<string, any>, cfg: GptFastConfig, p: Provider, explicit = false, forcedMode?: SpeedMode): Record<string, any> {
  const mode = forcedMode ?? resolveRequestSpeedMode(input.service_tier, cfg);
  const body = { ...input }, model = String(body.model || p.model || '');
  if (model) body.model = model;
  // A global GPT preference must not silently send GPT-only parameters to Grok/Kimi/etc.
  const otherFamily = /grok|kimi|deepseek|glm|zhipu|moonshot|qwen|gemini/i.test(`${model} ${p.phuketPlatform ?? ''}`);
  const supported = explicit || /^(?:gpt-|codex|o[1-9](?:-|$))/i.test(model) || Object.hasOwn(cfg.fastModelMap, model) || p.codexFastConfig != null || p.appType === 'codex' && !otherFamily;
  if (supported) {
    body.model = fastModel(model, cfg, mode);
    body.service_tier = fastTier(cfg, mode);
  }
  return body;
}
