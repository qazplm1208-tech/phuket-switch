import { allowedGroupModels, defaultBaseUrlForApp, DEFAULT_PROXY_PORT, MODEL_SLUG, PHUKET_BASE_URL, PHUKET_GPT_BASE_URL, pickRecommendedModel } from '@shared/constants';
import { parseSubagentBase, subagentApiRoot } from '@shared/subagentEndpoint';
import type { ApplySubagentRequest, PhuketApiKeyView, PhuketGroup, ProviderView, SubagentConfig, SubagentHarnessId, SubagentProtocol, SubagentStatus, SubagentTestRequest } from '@shared/types';

export const protocols: Record<SubagentProtocol, readonly [string, string]> = {
  'openai-responses': ['OpenAI Responses', '/v1/responses'], 'openai-chat': ['OpenAI Chat', '/v1/chat/completions'],
  'anthropic-messages': ['Anthropic Messages', '/v1/messages'], 'gemini-native': ['Gemini 原生', '/v1beta/models'],
};
export const endpointPresets: ReadonlyArray<{ label: string; baseUrl: string; protocol?: SubagentProtocol }> = [
  { label: 'PhuketAI', baseUrl: PHUKET_GPT_BASE_URL },
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', protocol: 'openai-responses' },
  { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', protocol: 'openai-chat' },
  { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', protocol: 'openai-chat' },
  { label: 'Anthropic', baseUrl: 'https://api.anthropic.com', protocol: 'anthropic-messages' },
  { label: 'Gemini', baseUrl: 'https://generativelanguage.googleapis.com', protocol: 'gemini-native' },
  { label: '本地代理', baseUrl: `http://127.0.0.1:${DEFAULT_PROXY_PORT}` },
];
export const fallbacks: Record<SubagentProtocol, string[]> = {
  'openai-responses': ['gpt-6.2-astra', 'gpt-6.2-sol'], 'openai-chat': ['deepseek-reasoner', 'deepseek-chat', 'gpt-6.2-sol'],
  'anthropic-messages': ['claude-opus-4-6', 'claude-sonnet-4-6'], 'gemini-native': ['gemini-2.5-pro', 'gemini-2.5-flash'],
};
export const sourceNames = { provider: '已有供应商', 'phuket-group': 'PhuketAI 分组', manual: '手动密钥', 'user-env': '用户环境变量' };
export const harnessName = (id: SubagentHarnessId, name: string) => id === 'antigravity' ? 'Antigravity（反重力）' : name;
export interface Draft extends Pick<SubagentConfig, 'protocol' | 'baseUrl' | 'model' | 'reasoningEffort' | 'defaultMode' | 'enableChunkCompaction' | 'allowModelOverride' | 'writeRules' | 'keyStorage'> {
  compactTriggerPct: string; compactKeepRecentGroups: string;
  source: 'provider' | 'phuket-group' | 'manual'; providerId: string; groupId: string; keyChoice: string;
  manual: 'saved' | 'env' | 'new'; context: string; pythonPath: string; customInstructions: string; targets: SubagentHarnessId[];
}
export function draftFrom({ config: c, userEnvHasKey, harnesses }: SubagentStatus): Draft {
  return { source: c.keySource === 'user-env' ? 'manual' : c.keySource, providerId: c.providerId ?? '', groupId: c.groupId == null ? '' : String(c.groupId),
    keyChoice: c.keyId == null ? 'auto' : `key:${c.keyId}`, manual: c.keySource === 'user-env' && userEnvHasKey ? 'env' : c.maskedKey ? 'saved' : userEnvHasKey && c.keyStorage === 'user-env' ? 'env' : 'new',
    protocol: c.protocol, baseUrl: c.baseUrl, model: c.model, reasoningEffort: c.reasoningEffort, defaultMode: c.defaultMode, context: String(c.maxContextTokens),
    enableChunkCompaction: c.enableChunkCompaction, compactTriggerPct: String(c.compactTriggerPct), compactKeepRecentGroups: String(c.compactKeepRecentGroups),
    allowModelOverride: c.allowModelOverride, writeRules: c.writeRules, keyStorage: c.keyStorage, pythonPath: c.pythonPath ?? '', customInstructions: c.customInstructions ?? '',
    targets: harnesses.filter(h => c.targets[h.id] || h.installed).map(h => h.id) };
}
export function providerDefaults(p: ProviderView): Partial<Draft> {
  return { providerId: p.id, protocol: p.protocol, baseUrl: p.baseUrl, ...(p.model ? { model: p.model } : {}) };
}
export function groupDefaults(g: PhuketGroup): Partial<Draft> {
  if (!g.protocol || !g.supportedAppTypes.length) return {};
  return { groupId: String(g.id), keyChoice: 'auto', protocol: g.protocol, baseUrl: defaultBaseUrlForApp(g.supportedAppTypes[0], g),
    model: pickRecommendedModel(allowedGroupModels(g), g.protocol) ?? fallbacks[g.protocol][0] };
}
export function origin(value: string) {
  return parseSubagentBase(value)?.origin ?? '';
}
export function resolvedEndpointPreview(baseUrl: string, protocol: SubagentProtocol, model: string) {
  const base = parseSubagentBase(baseUrl.trim());
  if (!base) return '';
  const root = subagentApiRoot(base, protocol);
  if (protocol === 'gemini-native') {
    if (!MODEL_SLUG.test(model.trim())) return '';
    return `${root}/models/${encodeURIComponent(model.trim()).replace(/%3A/g, ':')}:generateContent`;
  }
  return root + { 'openai-responses': '/responses', 'openai-chat': '/chat/completions', 'anthropic-messages': '/messages' }[protocol];
}
export function boundOrigin(d: Draft, status: SubagentStatus, provider?: ProviderView) {
  if (d.source === 'provider') return provider ? origin(provider.baseUrl) : '';
  if (d.source === 'phuket-group') return origin(PHUKET_BASE_URL);
  return d.manual === 'new' ? '' : origin(status.config.baseUrl);
}
export function needsOriginKey(d: Draft, status: SubagentStatus, provider?: ProviderView) {
  const bound = boundOrigin(d, status, provider), destination = origin(d.baseUrl.trim());
  return !!bound && !!destination && destination !== bound;
}
export function endpointIssue(d: Draft) {
  if (!MODEL_SLUG.test(d.model.trim())) return '请输入有效的模型标识，可包含字母、数字和 . _ : / @ -。';
  if (!origin(d.baseUrl.trim())) return '请输入 HTTP 或 HTTPS 基础地址，不要包含账号、密码、查询参数或片段。';
  return '';
}
export function sourceIssue(d: Draft, s: SubagentStatus, key: string, logged: boolean, p?: ProviderView, g?: PhuketGroup, keys: PhuketApiKeyView[] = []) {
  const validKey = /^[\x21-\x7e]{1,16384}$/.test(key.trim());
  if (needsOriginKey(d, s, p)) return validKey ? '' : '已切换为其他 API 地址，请填写该地址对应的 API 密钥。';
  if (d.source === 'provider') { if (!p) return '请选择已有供应商。'; }
  else if (d.source === 'phuket-group') {
    if (!logged) return '请先登录 PhuketAI，再选择分组密钥。';
    if (!g?.protocol) return '请选择支持推理的分组。';
    if (d.keyChoice.startsWith('key:') && !keys.some(k => d.keyChoice === `key:${k.id}`)) return '所选密钥不在此分组的可用列表中，请重新选择。';
  } else if (d.manual === 'new') {
    if (!validKey) return '请输入有效的 API 密钥，或切换凭据来源。';
  } else if (d.manual === 'saved') { if (!s.config.maskedKey) return '尚未保存密钥。'; }
  else if (!s.userEnvHasKey || d.keyStorage !== 'user-env') return '请配置用户环境变量 ASTRA_API_KEY，或改用手动密钥。';
  return '';
}
function inRange(raw: string, min: number, max: number) {
  return raw.trim() !== '' && Number.isInteger(+raw) && +raw >= min && +raw <= max;
}
export function compactionIssue(d: Draft) {
  if (!inRange(d.context, 5712, 272000)) return '上下文上限须为 5,712 至 272,000 之间的整数。';
  if (!inRange(d.compactTriggerPct, 40, 95)) return '自动兜底触发阈值须为 40 至 95 之间的整数。';
  if (!inRange(d.compactKeepRecentGroups, 0, 20)) return '分块保留最近交互组须为 0 至 20 之间的整数。';
  return '';
}
export function triggerTokenHint(d: Draft) {
  if (!inRange(d.context, 5712, 272000) || !inRange(d.compactTriggerPct, 40, 95)) return '阈值范围：40% 至 95%。';
  const requested = Math.round(+d.context * +d.compactTriggerPct / 100);
  return requested < 5584 ? '受运行时下限限制，达到 5,584 词元时自动兜底压缩。'
    : `达到 ${d.compactTriggerPct}%（约 ${requested.toLocaleString('zh-CN')} 词元）时自动兜底压缩。`;
}
function usesManualKey(d: Draft, status: SubagentStatus, provider?: ProviderView) {
  return (d.source === 'manual' && d.manual === 'new') || needsOriginKey(d, status, provider);
}
export function buildRequest(d: Draft, key: string, status: SubagentStatus, provider?: ProviderView): ApplySubagentRequest {
  const source = usesManualKey(d, status, provider) ? { apiKey: key.trim() } : d.source === 'provider' ? { providerId: d.providerId }
    : d.source === 'phuket-group' ? { groupId: Number(d.groupId),
      ...(d.keyChoice === 'create' ? { autoCreatePhuketKey: true } : d.keyChoice.startsWith('key:') ? { phuketKeyId: Number(d.keyChoice.slice(4)) } : {}) }
    : { keepExistingKey: d.manual === 'saved' };
  return { ...source, protocol: d.protocol, baseUrl: d.baseUrl.trim(), model: d.model.trim(), reasoningEffort: d.reasoningEffort, defaultMode: d.defaultMode,
    enableChunkCompaction: d.enableChunkCompaction, compactTriggerPct: Number(d.compactTriggerPct), compactKeepRecentGroups: Number(d.compactKeepRecentGroups),
    maxContextTokens: Number(d.context), allowModelOverride: d.allowModelOverride, keyStorage: d.keyStorage, writeRules: d.writeRules,
    pythonPath: d.pythonPath.trim(), customInstructions: d.customInstructions.trim(), targets: [...d.targets] };
}
export function probeIssue(d: Draft, status: SubagentStatus, sourceError: string, provider?: ProviderView) {
  if (sourceError || needsOriginKey(d, status, provider)) return sourceError;
  const c = status.config;
  if (d.source === 'phuket-group' && !(c.keySource === 'phuket-group' && c.groupId === Number(d.groupId) && c.maskedKey && d.keyChoice !== 'create' && (d.keyChoice === 'auto' || d.keyChoice === `key:${c.keyId}`))) return '部署所选分组密钥后可探测上游。';
  if (d.source === 'manual' && d.manual === 'env' && (c.keyStorage !== 'user-env' || (c.maskedKey && c.keySource !== 'user-env') || origin(c.baseUrl) !== origin(d.baseUrl.trim()))) return '部署环境变量配置后可探测上游。';
  return '';
}
export function testRequest(d: Draft, key: string, testUpstream: boolean, status: SubagentStatus, provider?: ProviderView): SubagentTestRequest {
  const manualKey = usesManualKey(d, status, provider);
  return { pythonPath: d.pythonPath.trim(), model: d.model.trim(), protocol: d.protocol, baseUrl: d.baseUrl.trim(), testUpstream,
    ...(!manualKey && d.source === 'provider' && d.providerId ? { providerId: d.providerId } : {}),
    ...(testUpstream && manualKey ? { apiKey: key.trim() } : {}) };
}
export const maskOnly = (s?: string) => !s ? '' : /\*{2,}|•{2,}|\.{3}|…|\[REDACTED\]/i.test(s) ? s : '••••';
export function safePreview(text: string, secret: string) {
  // Render and copy the same redacted text. Never serialize a write request as a preview.
  if (secret.trim()) for (const literal of [secret.trim(), JSON.stringify(secret.trim()).slice(1, -1)]) text = text.replaceAll(literal, '[REDACTED]');
  return text.replace(/("ASTRA_API_KEY"\s*:\s*)"(?:\\.|[^"\\])*"/gi, '$1"[REDACTED]"')
    .replace(/^(\s*ASTRA_API_KEY\s*=\s*).*$/gim, '$1"[REDACTED]"');
}
export function warningText(w: string) {
  if (w.includes('not written to MCP files')) return '密钥仅存入 Windows 用户环境变量；写入后请重新启动客户端。';
  if (w.includes('contain an API key')) return '实际配置文件将包含 API 密钥。预览已脱敏，请妥善保管文件和备份。';
  if (w.includes('Python 3.10')) return '部署前需要安装 Python 3.10 或更高版本。';
  return '请检查配置文件和运行环境后再写入。';
}
