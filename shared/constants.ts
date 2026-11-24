import type { PhuketApiKeyView, PhuketGroupMetadata } from './types.js';
import type { AppType, ClaudeModelMap, GptFastConfig, PhuketGroup, ProtocolType, ProxySettings, SpeedMode } from './types.js';

export const APP_VERSION = '1.0.2';
export const GITHUB_REPO_OWNER = 'qazplm1208-tech';
export const GITHUB_REPO_NAME = 'phuket-switch';
export const GITHUB_REPO_URL = `https://github.com/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}`;
export const GITHUB_RELEASES_URL = `${GITHUB_REPO_URL}/releases`;

export const PHUKET_BASE_URL = 'https://ai.pukitcore.com';
export const PHUKET_GPT_BASE_URL = 'https://ai.pukitcore.com/v1';
export const PHUKET_GEMINI_BASE_URL = PHUKET_BASE_URL;
export const PHUKET_ANTIGRAVITY_BASE_URL = `${PHUKET_BASE_URL}/antigravity`;

export function protocolForApp(app: AppType): ProtocolType {
  switch (app) {
    case 'claude': case 'claude-desktop': return 'anthropic-messages';
    case 'gemini': case 'antigravity': return 'gemini-native';
    case 'codex': case 'gpt-native': return 'openai-responses';
  }
}
export function defaultBaseUrlForApp(app: AppType, group?: Pick<PhuketGroup, 'adapterCategory' | 'platform'> | null): string {
  const protocol = protocolForApp(app);
  if (protocol === 'openai-responses') return PHUKET_GPT_BASE_URL;
  if (group?.adapterCategory === 'antigravity' || group?.platform.trim().toLowerCase() === 'antigravity') return PHUKET_ANTIGRAVITY_BASE_URL;
  return protocol === 'gemini-native' ? PHUKET_GEMINI_BASE_URL : PHUKET_BASE_URL;
}
export const DEFAULT_SERVER_PORT = 15720;
export const DEFAULT_PROXY_PORT = 15722;
export const DEFAULT_PROXY_SETTINGS: ProxySettings = {
  host: '127.0.0.1',
  port: DEFAULT_PROXY_PORT,
  failoverEnabled: true,
  requestTimeoutMs: 60_000,
  logRequests: true,
};

export function isUltraFastGroup(target: { id?: number | string | null; name?: string | null; phuketGroupId?: number | null; phuketGroupName?: string | null }): boolean {
  // Provider IDs are opaque strings; only numeric Phuket group IDs identify a group.
  return target.id === 153 || target.id === 154 || target.phuketGroupId === 153 || target.phuketGroupId === 154
    || /ultra[-_\s]?fast/i.test(`${target.name ?? ''} ${target.phuketGroupName ?? ''}`);
}

export function effectiveSpeedMode(cfg: Pick<GptFastConfig, 'enabled' | 'serviceTier' | 'speedMode'>): SpeedMode {
  if (cfg.speedMode === 'standard' || cfg.speedMode === 'fast' || cfg.speedMode === 'ultrafast') return cfg.speedMode;
  if (!cfg.enabled) return 'standard';
  return cfg.serviceTier === 'ultrafast' ? 'ultrafast' : 'fast';
}

export const VIRTUAL_FAST_SUFFIX = '--fast';
export const VIRTUAL_ULTRAFAST_SUFFIX = '--ultrafast';
export function isSpeedVariantCandidateModel(slug: string): boolean {
  return /^gpt-\d/i.test(slug) && !/gpt-image-|codex-auto-review|chat-latest|gpt-reserve|-fast$|--ultrafast$/i.test(slug)
    && !/^gpt-(?:5\.6|6)$/i.test(slug);
}

export const DEFAULT_GPT_FAST_CONFIG: GptFastConfig = {
  enabled: true,
  serviceTier: 'priority',
  speedMode: 'fast',
  ultraFastProviderId: null,
  respectClientServiceTier: false,
  catalogSpeedVariants: true,
  strategy: 'tier_only',
  injectCodexCatalogFast: true,
  fastModelMap: {
    'gpt-6-astra': 'gpt-6-astra-fast',
    'gpt-6.1-sol': 'gpt-6.1-sol-fast',
  },
};

/** Suffix variants for the local catalog, not a guarantee of group availability. */
export const KNOWN_FAST_MODELS: readonly string[] = Object.values(DEFAULT_GPT_FAST_CONFIG.fastModelMap);

export const DEFAULT_CLAUDE_MODEL_MAP: ClaudeModelMap = {
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-4-5-20251001',
  defaultModel: 'claude-sonnet-5-5',
};

export const MODEL_SLUG = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$/;

export function providerModelNames(provider: { model?: string; availableModels?: string[] }, group?: Pick<PhuketGroup, 'models'>): string[] {
  return [...new Set([provider.model, ...(provider.availableModels ?? []), ...allowedGroupModels(group)].filter((m): m is string => !!m))];
}

export function allowedGroupModels(group?: Pick<PhuketGroup, 'models'>): string[] {
  return group?.models.filter(m => m.operating_access?.allowed !== false).map(m => m.name) ?? [];
}

// Compare version components numerically (5.10 > 5.9); compare release dates only on ties.
export function sortModelsNewestFirst(models: string[]): string[] {
  const ranked = [...new Set(models.map(m => m.trim()).filter(Boolean))].map(name => {
    const slug = name.replace(/-(\d{8})$/, '');
    const version = (slug.match(/\d+/g) ?? []).map(Number);
    const variant = /-astra(?:-|$)/i.test(slug) ? 2 : /-terra(?:-|$)/i.test(slug) ? 1 : 0;
    return { name, version, variant, date: Number(name.slice(slug.length + 1)) };
  });
  return ranked.sort((a, b) => {
    for (let i = 0; i < Math.max(a.version.length, b.version.length); i++) {
      const diff = (b.version[i] ?? -1) - (a.version[i] ?? -1);
      if (diff) return diff;
    }
    return b.variant - a.variant || b.date - a.date || a.name.localeCompare(b.name, 'en');
  }).map(m => m.name);
}

export function pickRecommendedModel(models: string[], protocol: ProtocolType): string | undefined {
  const sorted = sortModelsNewestFirst(models).filter(m => !/^gpt-image-/i.test(m));
  if (protocol === 'gemini-native') {
    const chat = sorted.filter(m => !/image/i.test(m));
    const native = chat.filter(m => /^gemini-/i.test(m));
    const flagship = native.filter(m => !/lite/i.test(m));
    const version = (m: string) => /^gemini-([\d.]+)/i.exec(m)?.[1];
    const newest = flagship.filter(m => version(m) === version(flagship[0] ?? ''));
    return newest.find(m => /-hydrogen(?:-|$)|-pro(?:-|$)/i.test(m)) ?? flagship[0] ?? native[0] ?? chat[0];
  }
  if (protocol === 'anthropic-messages') {
    return sorted.find(m => /sonnet/i.test(m)) ?? sorted.find(m => /opus/i.test(m)) ?? sorted[0];
  }
  const usable = sorted.filter(m => !/chat-latest|codex-auto-review/i.test(m));
  const base = usable.filter(m => !m.endsWith('-fast'));
  return base.find(m => /^gpt-\d/i.test(m) && !/(?:mini|nano|codex|chat)/i.test(m))
    ?? base[0] ?? usable[0] ?? sorted[0];
}

export function buildSuggestedClaudeMap(models: string[]): ClaudeModelMap {
  const sorted = sortModelsNewestFirst(models);
  if (!sorted.length) return {};
  const opus = sorted.find(m => /opus/i.test(m));
  const sonnet = sorted.find(m => /sonnet/i.test(m)) ?? opus ?? sorted[0];
  return { opus: opus ?? sonnet, sonnet, haiku: sorted.find(m => /haiku/i.test(m)) ?? sonnet, defaultModel: sonnet };
}

export function buildAllFastModelMap(models: string[], existing: Record<string, string> = {}): Record<string, string> {
  const available = new Set(sortModelsNewestFirst(models));
  const map = new Map(Object.entries(existing));
  for (const model of available) {
    if (model.endsWith('-fast')) continue;
    const target = `${model}-fast`;
    map.set(model, available.has(target) ? target : map.get(model) ?? model);
  }
  return Object.fromEntries(map);
}

type GroupIdentity = Pick<PhuketGroup, 'id' | 'name' | 'platform'>;
type GroupRouting = Pick<PhuketGroup, 'adapterCategory' | 'protocol' | 'supportedAppTypes'>;

/** Pure, ordered classification; keep unsupported groups visible but not switchable. */
export function classifyPhuketGroup({ id, name, platform }: GroupIdentity): GroupRouting {
  const identity = `${platform.trim()} ${name.trim()}`;
  if (id === 32 || /生图|image/i.test(identity)) {
    return { adapterCategory: 'image_prompt', protocol: null, supportedAppTypes: [] };
  }
  if (id === 129 || /视频|video/i.test(identity)) {
    return { adapterCategory: 'media_coming_soon', protocol: null, supportedAppTypes: [] };
  }
  if (/antigravity|反重力/i.test(identity)) return { adapterCategory: 'antigravity', protocol: 'gemini-native', supportedAppTypes: ['antigravity', 'gemini', 'claude', 'claude-desktop', 'codex'] };
  if (/gemini/i.test(identity)) return { adapterCategory: 'gemini', protocol: 'gemini-native', supportedAppTypes: ['gemini', 'antigravity', 'codex'] };
  if (/anthropic|claude/i.test(identity)) {
    return { adapterCategory: 'claude', protocol: 'anthropic-messages', supportedAppTypes: ['claude', 'claude-desktop'] };
  }

  const adapterCategory = /deepseek|kimi|glm|zhipu|moonshot/i.test(identity) ? 'domestic'
    : /grok|xai/i.test(identity) ? 'grok'
    : /openai|gpt/i.test(identity) ? 'gpt' : 'domestic';
  return { adapterCategory, protocol: 'openai-responses', supportedAppTypes: ['codex', 'gpt-native'] };
}

export function canCreateGroupKey(group: PhuketGroup, allowed?: number[] | null) {
  return (!!group.protocol || group.adapterCategory === 'image_prompt') && group.status === 'active' && group.operating_access?.allowed !== false &&
    !(group.is_exclusive && Array.isArray(allowed) && !allowed.includes(group.id));
}

export function workbenchGroup(key: PhuketApiKeyView, groups: PhuketGroup[]): PhuketGroupMetadata | null {
  const summary = key.group, group = groups.find(g => g.id === (key.group_id ?? summary?.id));
  if (key.status !== 'active' || (!group && !summary)) return null;
  for (const g of [summary, group]) {
    if (g && (g.claude_code_only || classifyPhuketGroup(g).protocol !== 'openai-responses')) return null;
  }
  if (group && group.protocol !== 'openai-responses') return null;
  return group ?? summary ?? null;
}

export function isWorkbenchChatModel(id: string) {
  return MODEL_SLUG.test(id) && !/(?:^|[/:])(?:claude-|gemini-|gpt-image-|sora(?:-|$)|veo(?:-|\d|$)|kling(?:-|$)|seedance(?:-|$)|wan(?:-|\d))|(?:^|[-_/])(?:video|image)(?:[-_/]|$)/i.test(id);
}

// Public model-plaza reference data only. No account permissions, promotions or model availability cached here.
const referenceGroups: (GroupIdentity & { rate_multiplier: number; is_exclusive?: boolean })[] = [
  { id: 49, name: 'Pro 500', platform: 'openai', rate_multiplier: 0.18 },
  { id: 142, name: 'VIP专属分组 Pro 500', platform: 'openai', rate_multiplier: 0.16, is_exclusive: true },
  { id: 153, name: 'Pro500 ultrafast', platform: 'openai', rate_multiplier: 0.5 },
  { id: 154, name: 'Pro500 ultrafast 下游', platform: 'openai', rate_multiplier: 1 },
  { id: 136, name: '下游Pro500分组', platform: 'openai', rate_multiplier: 1 },
  { id: 65, name: '0.50 官方GPT', platform: 'openai', rate_multiplier: 0.5 },
  { id: 107, name: '1.2 Claude CC MAX 不含Fable', platform: 'anthropic', rate_multiplier: 1.1 },
  { id: 138, name: '1.6 CCMax 0注入 含Fable5-2', platform: 'anthropic', rate_multiplier: 1.6 },
  { id: 25, name: '0.15 Claude-kiro渠道', platform: 'anthropic', rate_multiplier: 0.15 },
  { id: 127, name: 'Deepseek-1017', platform: 'deepseek', rate_multiplier: 0.6 },
  { id: 32, name: '生图-image', platform: 'openai', rate_multiplier: 1 },
  { id: 132, name: '0.6 gemini', platform: 'gemini', rate_multiplier: 0.6 },
  { id: 124, name: '0.35 Gemini', platform: 'gemini', rate_multiplier: 0.35 },
];

/** Offline display only. Multipliers are reference standard rates, never live quotes. */
export const FALLBACK_PHUKET_GROUPS: PhuketGroup[] = referenceGroups.map(group => ({
  ...group,
  status: 'unknown',
  description: '',
  is_exclusive: group.is_exclusive ?? false,
  standard_rate_multiplier: group.rate_multiplier,
  models: [],
  ...classifyPhuketGroup(group),
}));
