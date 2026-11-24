/** Shared JSON contract. Timestamps are ISO 8601 strings, durations are milliseconds. */
export type AppType = 'claude' | 'codex' | 'gpt-native' | 'claude-desktop' | 'gemini' | 'antigravity';
export type ProtocolType = 'anthropic-messages' | 'openai-responses' | 'gemini-native';
export type ServiceTier = 'default' | 'auto' | 'priority' | 'fast' | 'ultrafast' | 'flex';
export type SpeedMode = 'standard' | 'fast' | 'ultrafast';
export type FastStrategy = 'tier_only' | 'fast_suffix' | 'hybrid';
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';

/** Only Fast can map model slugs; hybrid can retry the base model. */
export interface GptFastConfig {
  enabled: boolean;
  serviceTier: ServiceTier;
  strategy: FastStrategy;
  /** Accepted from older saved configs; never applied. */
  reasoningEffort?: ReasoningEffort;
  injectCodexCatalogFast: boolean;
  fastModelMap: Record<string, string>;
  /** Authoritative when present; older configs infer the mode from enabled and serviceTier. */
  speedMode?: SpeedMode;
  ultraFastProviderId?: string | null;
  /** Codex omits the wire tier for Standard. When false, an omitted tier uses the configured mode. */
  respectClientServiceTier?: boolean;
  /** Offer model-menu speed variants only when Codex points at the local proxy. */
  catalogSpeedVariants?: boolean;
}

/** Missing entries leave that Claude model selection unchanged. */
export interface ClaudeModelMap {
  opus?: string;
  sonnet?: string;
  haiku?: string;
  defaultModel?: string;
}

/** Local stored provider, NOT the read DTO. A lower priority number is tried first. */
export interface Provider {
  id: string;
  appType: AppType;
  name: string;
  protocol: ProtocolType;
  baseUrl: string;
  apiKey: string;
  maskedKey?: string;
  phuketGroupId?: number;
  phuketGroupName?: string;
  phuketPlatform?: string;
  rateMultiplier?: number;
  model?: string;
  claudeModelMap?: ClaudeModelMap;
  codexFastConfig?: GptFastConfig;
  availableModels?: string[];
  isCurrent: boolean;
  inFailoverQueue: boolean;
  priority: number;
  notes?: string;
  lastLatencyMs?: number;
  lastTestedAt?: string;
  lastTestOk?: boolean;
  createdAt: string;
  updatedAt: string;
}

export type ProviderView = Omit<Provider, 'apiKey'>;
export type CreateProviderRequest = Pick<Provider, 'appType' | 'name' | 'protocol' | 'baseUrl'> & {
  apiKey?: string;
  phuketKeyId?: number;
  autoCreatePhuketKey?: boolean;
} &
  Partial<Pick<Provider, 'phuketGroupId' | 'phuketGroupName' | 'phuketPlatform' | 'rateMultiplier' |
  'model' | 'claudeModelMap' | 'codexFastConfig' | 'availableModels' | 'inFailoverQueue' | 'priority' | 'notes'>>;
/** Omit all credential sources to keep the stored secret. appType and server-owned fields cannot be patched. */
export type UpdateProviderRequest = Partial<Omit<CreateProviderRequest, 'appType' | 'codexFastConfig' | 'phuketGroupId'>> & {
  /** null removes the PhuketAI group association and its descriptive metadata. */
  phuketGroupId?: number | null;
  /** null restores inheritance from the global setting. */
  codexFastConfig?: GptFastConfig | null;
};

export interface SystemApplyResult {
  applied: boolean;
  backupId: string | null;
  changedPaths: string[];
  warnings?: string[];
}

export interface ActivateProviderRequest { applyToSystem?: boolean }
export interface ActivateProviderResult { provider: ProviderView; system: SystemApplyResult }

export interface KeyUsageSnapshot {
  balance: number | null;
  remaining: number | null;
  unit: string;
  planName: string | null;
  todayRequests: number | null;
  todayTokens: number | null;
  todayActualCost: number | null;
  totalRequests: number | null;
  totalTokens: number | null;
  totalActualCost: number | null;
}

export interface ProviderTestResult {
  providerId: string;
  ok: boolean;
  latencyMs: number;
  modelsOk: boolean;
  modelsCount: number;
  models: string[];
  usageOk: boolean;
  usage: KeyUsageSnapshot | null;
  error?: string;
  testedAt: string;
}

export interface UpdateFastModeRequest { config: GptFastConfig; applyToCodex?: boolean }
export interface UpdateFastModeResult { config: GptFastConfig; system: SystemApplyResult }
export interface SetupUltraFastRequest {
  groupId?: number;
  phuketKeyId?: number;
  autoCreatePhuketKey?: boolean;
  apiKey?: string;
  applyToCodex?: boolean;
  enableCodexMenu?: boolean;
}
export interface SetupUltraFastResult { provider: ProviderView; fastMode: GptFastConfig; system: SystemApplyResult; proxy?: ProxyStatus }

// Phuket wire data: preserve upstream field names, numeric IDs and nulls.
export type GroupAdapterCategory = 'claude' | 'gpt' | 'gemini' | 'antigravity' | 'domestic' | 'grok' | 'image_prompt' | 'media_coming_soon';

/** Account portion of /api/v1/auth/me. null allowed_groups is not an empty allowlist. */
export interface PhuketAccount {
  id: number;
  email: string;
  username: string;
  role: string;
  status: string;
  balance: number;
  frozen_balance: number;
  total_recharged: number;
  concurrency: number;
  rpm_limit: number;
  allowed_groups: number[] | null;
  avatar_url?: string | null;
  last_active_at?: string | null;
  created_at: string;
}

/** Upstream access policy, distinct from local adapter support. */
export interface PhuketOperatingAccess {
  allowed: boolean;
  reason: string;
  model_restrictions: boolean;
  allowed_models: string[] | null;
  denied_models: string[] | null;
}

export interface PhuketPricingOffer {
  group_id: number;
  group_name: string;
  standard_rate: number;
  sale_rate: number;
  enabled: boolean;
  starts_at: string | null;
  ends_at: string | null;
  revision: number;
  server_time: string;
}

/** Native per-token prices (not scaled per million). null means not priced, not free. */
interface TokenPrices {
  input_price: number | null;
  output_price: number | null;
  cache_write_price: number | null;
  cache_write_1h_price: number | null;
  cache_write_12h_price: number | null;
  cache_read_price: number | null;
}

/** A token range or labelled media tier; null max_tokens is open-ended. */
export interface PhuketPricingInterval extends TokenPrices {
  min_tokens: number;
  max_tokens: number | null;
  tier_label: string;
  input_multiplier: number | null;
  output_multiplier: number | null;
  cache_write_multiplier: number | null;
  cache_read_multiplier: number | null;
  per_request_price: number | null;
}

/** Group-specific pricing under model-plaza groups[].models[].pricing. */
export interface PhuketModelPricing extends TokenPrices {
  billing_mode: string;
  image_input_price: number | null;
  image_output_price: number | null;
  per_request_price: number | null;
  intervals: PhuketPricingInterval[];
  reasoning_effort_multipliers?: Record<string, number>;
}

/** The official reference price is sparse; it is not another group tariff. */
export interface PhuketOfficialPricing extends Partial<TokenPrices> {
  intervals?: PhuketPricingInterval[];
}

export interface PhuketGroupModel {
  name: string;
  platform: string;
  operating_access?: PhuketOperatingAccess | null;
  pricing: PhuketModelPricing | null;
  official_pricing: PhuketOfficialPricing | null;
  long_context_basis?: string;
  video_prices?: Record<string, number>;
}

/** Fields consumed from /groups/available; also the group summary nested in keys. */
export interface PhuketGroupMetadata {
  id: number;
  name: string;
  platform: string;
  description: string;
  status: string;
  claude_code_only?: boolean;
  is_exclusive: boolean;
  rate_multiplier: number;
  standard_rate_multiplier?: number;
  pricing_offer?: PhuketPricingOffer | null;
  operating_access?: PhuketOperatingAccess | null;
}

export type PhuketPlazaGroup = Omit<PhuketGroupMetadata, 'status'> & { models: PhuketGroupModel[] };

/** Joined by numeric ID. Disabled/coming-soon groups have null protocol and no client apps. */
export interface PhuketGroup extends PhuketGroupMetadata {
  models: PhuketGroupModel[];
  adapterCategory: GroupAdapterCategory;
  protocol: ProtocolType | null;
  supportedAppTypes: AppType[];
}

/** Server-side /api/v1/keys row. Retired or masked keys need not expose a usable key. */
export interface PhuketApiKey {
  id: number;
  user_id: number;
  name: string;
  key?: string;
  key_display?: string;
  managed_trial?: boolean;
  group_id: number | null;
  group?: PhuketGroupMetadata | null;
  status: 'active' | 'inactive' | 'quota_exhausted' | 'expired';
  ip_whitelist: string[] | null;
  ip_blacklist: string[] | null;
  last_used_at: string | null;
  last_used_ip?: string | null;
  current_concurrency?: number;
  quota: number;
  quota_used: number;
  expires_at: string | null;
  rate_limit_5h: number;
  rate_limit_1d: number;
  rate_limit_7d: number;
  usage_5h: number;
  usage_1d: number;
  usage_7d: number;
  window_5h_start: string | null;
  window_1d_start: string | null;
  window_7d_start: string | null;
  reset_5h_at: string | null;
  reset_1d_at: string | null;
  reset_7d_at: string | null;
  created_at: string;
  updated_at: string;
  today_actual_cost?: number;
  total_actual_cost?: number;
}

/** Local list responses use a display-only mask, never PhuketApiKey.key. */
export type PhuketApiKeyView = Omit<PhuketApiKey, 'key' | 'key_display'> & { key_display: string };

export interface PhuketUsageStats {
  total_api_keys: number;
  active_api_keys: number;
  total_requests: number;
  today_requests: number;
  total_tokens: number;
  today_tokens: number;
  total_input_tokens: number;
  today_input_tokens: number;
  total_output_tokens: number;
  today_output_tokens: number;
  total_cache_creation_tokens: number;
  today_cache_creation_tokens: number;
  total_cache_read_tokens: number;
  today_cache_read_tokens: number;
  total_cost: number;
  today_cost: number;
  total_actual_cost: number;
  today_actual_cost: number;
  average_duration_ms: number;
  rpm: number;
  tpm: number;
}

interface PhuketUsageTotals {
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  total_tokens: number;
  cost: number;
  actual_cost: number;
}
export type PhuketUsageTrendPoint = PhuketUsageTotals & { date: string };
export type PhuketModelUsage = PhuketUsageTotals & { model: string };

/** UI-safe projection of a usage log (no upstream request or response contents). */
export interface PhuketUsageLog {
  id: number;
  api_key_id: number;
  model: string;
  input_tokens: number;
  output_tokens: number;
  actual_cost: number;
  duration_ms: number | null;
  created_at: string;
}

export interface PhuketKeyUsage {
  api_key_id: number;
  today_actual_cost: number;
  total_actual_cost: number;
}

/** Unavailable stats are null. A key-cost fallback never manufactures token counts. */
export interface PhuketUsageDashboard {
  stats: PhuketUsageStats | null;
  trend: PhuketUsageTrendPoint[];
  models: PhuketModelUsage[];
  recentLogs: PhuketUsageLog[];
  keyUsageFallback: PhuketKeyUsage[] | null;
}

// Channel-monitor snapshots originate on Phuket. Local probes are separate, on demand.
export type ChannelMonitorStatus = 'operational' | 'degraded' | 'failed' | 'error' | 'unknown';

export interface ChannelMonitorTimelinePoint {
  checked_at: string;
  status: ChannelMonitorStatus;
  latency_ms: number | null;
  ping_latency_ms: number | null;
}

export interface ChannelMonitorItem {
  id: number;
  name: string;
  provider: string;
  group_id?: number | null;
  group_name: string;
  group_rate_multiplier?: number | null;
  primary_model: string;
  primary_status: ChannelMonitorStatus;
  primary_latency_ms: number | null;
  primary_ping_latency_ms: number | null;
  availability_7d: number;
  extra_models: { model: string; status: ChannelMonitorStatus; latency_ms: number | null }[];
  timeline: ChannelMonitorTimelinePoint[];
}

/** Multi-window measurements for one model on a channel. */
export interface ChannelMonitorModelDetail {
  model: string;
  latest_status: ChannelMonitorStatus;
  latest_latency_ms: number | null;
  availability_7d: number;
  availability_15d: number;
  availability_30d: number;
  avg_latency_7d_ms: number | null;
}

export interface ChannelMonitorDetail {
  id: number;
  name: string;
  provider: string;
  group_id?: number | null;
  group_name: string;
  models: ChannelMonitorModelDetail[];
}

export interface PaymentMethodInfo {
  payment_type: string;
  currency: string;
  fee_rate: number;
  daily_limit: number;
  single_min: number;
  single_max: number;
}
export interface PaymentCheckoutInfo {
  methods: Record<string, PaymentMethodInfo>;
  global_min: number;
  global_max: number;
  plans: unknown[];
  balance_disabled: boolean;
  balance_recharge_multiplier: number;
  recharge_fee_rate: number;
  recharge_bonus_tiers: unknown[];
  recharge_bonus_mode: string;
  recharge_bonus_notice: string;
  help_text: string;
  alipay_force_qrcode: boolean;
}
export interface CreatePaymentOrderRequest {
  amount: number;
  payment_type: string;
  order_type: 'balance' | 'subscription';
  plan_id?: number;
}
export interface PaymentOrderResult {
  order_id: number;
  out_trade_no: string;
  amount: number;
  pay_amount: number;
  payment_type: string;
  payment_mode?: string;
  currency: string;
  pay_url: string | null;
  qr_code?: string | null;
  expires_at?: string | null;
  status: string;
}
export interface PaymentOrderItem extends PaymentOrderResult { id: number; created_at?: string }
export const paymentStatuses = ['PENDING','PAID','COMPLETED','FAILED','REFUNDED','CANCELLED','EXPIRED'] as const;
export interface PaymentPageQuery { page?: number; page_size?: number }
export interface PaymentOrdersQuery extends PaymentPageQuery { status?: typeof paymentStatuses[number] }
export interface PaymentOrdersPage { items: PaymentOrderItem[]; total: number; page: number; page_size: number; pages: number }
export interface VerifyPaymentOrderRequest { out_trade_no: string }
export interface RedeemRequest { code: string }
export interface RedeemResult { ok: true; type?: string; value?: number }
export interface RedeemHistoryItem {
  id: number;
  /** Display mask only; never the redeem credential. */
  code?: string;
  type: string;
  value: number;
  status: string;
  used_at: string | null;
  created_at: string;
  group_id: number | null;
  validity_days: number | null;
}
export interface RedeemHistoryPage { items: RedeemHistoryItem[]; total?: number }

export interface PhuketAuthStatus {
  authenticated: boolean;
  account: PhuketAccount | null;
  baseUrl: string;
  requires2fa?: boolean;
  tempToken?: string;
  maskedEmail?: string;
}
export interface PhuketLoginRequest {
  email?: string;
  password?: string;
  totpCode?: string;
  tempToken?: string;
  token?: string;
  /** Optional account refresh credential; accepted only with token and never returned in management responses. */
  refreshToken?: string;
  acceptAgreement?: boolean;
}
export interface PhuketGroupsResponse { authenticated: boolean; description: string; groups: PhuketGroup[] }
export interface PhuketKeysPage { items: PhuketApiKeyView[]; total: number; page: number; pageSize: number }

export interface CreatePhuketKeyRequest {
  name: string;
  group_id: number;
  quota?: number;
  expires_at?: string | null;
}
export interface CreatePhuketKeyResult { item: PhuketApiKeyView; key: string }
export interface UpdatePhuketKeyRequest extends Partial<CreatePhuketKeyRequest> { status?: 'active' | 'inactive' }
export interface ImportPhuketKeyRequest { appType?: AppType; name?: string; model?: string }
export interface PhuketUsageResponse {
  source: 'dashboard' | 'key' | 'none';
  dashboard: PhuketUsageDashboard | null;
  keyUsage: KeyUsageSnapshot | null;
  providerId?: string | null;
}

export interface WorkbenchModelsQuery { keyId: number }
export interface WorkbenchModelOption { id: string; label: string }
export type ConnectionCheckTarget = 'direct' | 'proxy';
export interface ConnectionCheckRequest extends WorkbenchModelsQuery { providerId?: string; model: string; localTarget?: ConnectionCheckTarget }
export interface ConnectionStepError {
  code: string; httpStatus: number | null; networkCode: string | null;
  upstreamType: string | null; upstreamCode: string | null; message: string;
}
export interface OnlineCheckStepResult {
  status: 'passed' | 'failed'; ok: boolean; latencyMs: number; firstTokenMs: number | null;
  endpoint: string; model: string; previewText?: string; error?: ConnectionStepError;
}
export interface LocalCheckStepResult extends Omit<OnlineCheckStepResult, 'status' | 'latencyMs'> {
  status: 'passed' | 'failed' | 'skipped'; latencyMs: number | null; target: ConnectionCheckTarget;
}
export type DiagnosticActionKind = 'contact_admin' | 'recharge' | 'create_key_and_retest' | 'new_chat_codex_deeplink' | 'check_network';
export interface DiagnosticBalanceCheck {
  checked: boolean;
  accountBalance: number | null;
  keyQuota: number;
  keyQuotaUsed: number;
  sufficient: boolean;
  summary: string;
}
export interface DiagnosticGuidance {
  action: DiagnosticActionKind;
  title: string;
  steps: string[];
  balanceCheck?: DiagnosticBalanceCheck;
  recreateGroupId?: number | null;
}
export interface ConnectionCheckResult {
  groupId: number | null;
  guidance?: DiagnosticGuidance;
  startedAt: string; finishedAt: string; overallStatus: 'passed' | 'online_failed' | 'local_failed';
  contactAdmin: boolean; advice: string; keyId: number; keyName: string; groupName: string; model: string;
  online: OnlineCheckStepResult; local: LocalCheckStepResult; diagnosticReport: string;
}

export interface LocalProbeRequest { providerId: string; model?: string }

/** One user-initiated, protocol-aware check of a saved provider. */
export interface LocalProbeResult {
  providerId: string;
  model: string;
  protocol: ProtocolType;
  testedAt: string;
  ok: boolean;
  latencyMs: number | null;
  statusCode: number | null;
  error?: string;
}

export type RouteSourceClient = 'claude' | 'codex';
export interface ModelRouteInput {
  id?: string;
  enabled: boolean;
  sourceClient: RouteSourceClient;
  /** Exact model slug requested by the client, or '*' as a fallback. */
  sourceModel: string;
  targetProviderId: string;
  targetModel: string;
  note?: string;
}
export interface ModelRouteRule extends ModelRouteInput { id: string }
export interface UpdateModelRoutesRequest { rules: ModelRouteInput[] }
export interface AutoPopulateRoutesRequest {
  sourceClient?: RouteSourceClient | 'all';
  syncCodexCatalog?: boolean;
}
export interface AutoPopulateRoutesResult {
  rules: ModelRouteRule[];
  addedCount: number;
  system?: SystemApplyResult;
}

/** Configuration is independent of whether the loopback proxy is currently running. */
export interface ProxySettings {
  host: '127.0.0.1';
  port: number;
  failoverEnabled: boolean;
  requestTimeoutMs: number;
  logRequests: boolean;
}

export type ProxyTakeoverState = Record<AppType, boolean>;
export interface ProxyTakeoverRequest { appType: AppType; enable: boolean }
export interface ProxyTakeoverResult { proxy: ProxyStatus; system: SystemApplyResult }
export interface ProxyLogsPage { items: ProxyRequestLog[]; total: number }

export const directBypassModes = ['physical-nic', 'skip-proxy'] as const;
export type DirectBypassMode = typeof directBypassModes[number];
export interface DirectBypassConfig {
  enabled: boolean; mode: DirectBypassMode; interfaceName: string; dnsServers: string[]; applyToSubagent: boolean;
}
export interface DirectBypassRouteInfo {
  name: string; description: string; index: number | null; ipv4: string | null; ipv6: string | null;
  gateway: string | null; dnsServers: string[]; metric: number | null; systemRoute: boolean;
}
export interface DirectBypassStatus {
  config: DirectBypassConfig; bridgeRunning: boolean; selected: DirectBypassRouteInfo | null; adapters: DirectBypassRouteInfo[]; error: string | null;
}
export type UpdateDirectBypassRequest = Partial<DirectBypassConfig>;
export interface DirectBypassProbeRequest { url?: string }
export interface DirectBypassProbeResult {
  ok: boolean; statusCode: number | null; latencyMs: number; mode: DirectBypassMode; bypassUsed: boolean;
  route: DirectBypassRouteInfo | null; error: string | null; testedAt: string;
}

export interface ProxyStatus {
  takeover: ProxyTakeoverState;
  running: boolean;
  settings: ProxySettings;
  baseUrl: string | null;
  startedAt: string | null;
  requestCount: number;
  lastError?: string;
}

/** Request metadata only. Never include headers, credentials or message content. */
export interface ProxyRequestLog {
  id: string;
  createdAt: string;
  appType: AppType;
  protocol: ProtocolType;
  translatedFrom?: ProtocolType;
  providerId: string | null;
  model: string;
  effectiveModel: string;
  serviceTier?: ServiceTier;
  statusCode: number;
  latencyMs: number;
  failoverCount: number;
  fastFallback?: boolean;
  providerName?: string;
  ttftMs?: number | null;
  totalTokens?: number | null;
  error?: string;
}

/** Paired standard and Fast runs against the same provider. */
export interface SpeedCompareRequest {
  providerId: string;
  prompt?: string;
  model?: string;
  runs?: number;
  maxOutputTokens?: number;
  fastConfig?: GptFastConfig;
}

export interface SpeedCompareSample {
  mode: 'standard' | 'fast';
  run: number;
  ok: boolean;
  model: string;
  effectiveModel: string;
  serviceTier: ServiceTier;
  latencyMs: number;
  firstTokenMs: number | null;
  outputTokens: number | null;
  tokensPerSec: number | null;
  statusCode: number | null;
  previewText?: string;
  error?: string;
}

export interface SpeedCompareResult {
  startedAt: string;
  finishedAt: string;
  providerId: string;
  providerName: string;
  model: string;
  standardMedianMs: number | null;
  fastMedianMs: number | null;
  speedup: number | null;
  samples: SpeedCompareSample[];
}

export interface ChatTestRequest {
  providerId: string;
  model?: string;
  prompt: string;
  maxOutputTokens?: number;
  fastConfig?: GptFastConfig;
}

/** Non-streaming control-plane result (the proxy data plane can still stream). */
export interface ChatTestResult extends LocalProbeResult {
  text: string;
  effectiveModel: string;
  serviceTier?: ServiceTier;
  inputTokens?: number;
  outputTokens?: number;
}

// Local resources. IDs are opaque strings; the server owns paths and file writes.
export type McpTransport =
  | { type: 'stdio'; command: string; args: string[]; env?: Record<string, string> }
  | { type: 'http' | 'sse'; url: string; headers?: Record<string, string> };

export type McpTarget = 'claude' | 'codex';
export interface UpsertMcpRequest {
  target: McpTarget;
  name: string;
  enabled?: boolean;
  transport: McpTransport;
}
export interface McpServerItem {
  id: string;
  target: McpTarget;
  name: string;
  enabled: boolean;
  transport: McpTransport;
}

export interface CreatePromptRequest { name: string; appType: 'claude' | 'codex'; content: string }
export interface UpdatePromptRequest { name?: string; content?: string }

export interface ImagePromptConfig {
  enabled: boolean;
  groupId: number | null;
  groupName: string;
  baseUrl: string;
  defaultModel: string;
  models: string[];
  keyId: number | null;
  keyName: string;
  maskedKey: string;
  targets: Record<ImagePromptTarget, boolean>;
  customInstructions?: string;
  updatedAt: string | null;
}
export type ImagePromptTarget = 'codex' | 'claude';
export interface ImagePromptTargetState { path: string; exists: boolean; injected: boolean; }
export interface ImagePromptStatus { config: ImagePromptConfig; liveTargets: Record<ImagePromptTarget, ImagePromptTargetState>; previewMarkdown: string; }
export interface ApplyImagePromptRequest {
  groupId?: number;
  defaultModel?: string;
  models?: string[];
  targets: ImagePromptTarget[];
  phuketKeyId?: number;
  autoCreatePhuketKey?: boolean;
  apiKey?: string;
  customInstructions?: string;
}
export interface RemoveImagePromptRequest { targets: ImagePromptTarget[]; }
export interface ApplyImagePromptResult { status: ImagePromptStatus; system: SystemApplyResult; }


export const subagentHarnessIds = ['antigravity', 'claude-code', 'codex', 'gemini-cli', 'claude-desktop', 'cursor', 'windsurf', 'opencode', 'cline'] as const;
export type SubagentHarnessId = typeof subagentHarnessIds[number];
export const subagentProtocols = ['openai-responses', 'openai-chat', 'anthropic-messages', 'gemini-native'] as const;
export type SubagentProtocol = typeof subagentProtocols[number];
export type SubagentReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type SubagentMode = 'edit' | 'readonly';
export type SubagentKeyStorage = 'user-env' | 'mcp-env';
export type SubagentKeySource = 'provider' | 'phuket-group' | 'manual' | 'user-env';
export interface SubagentConfig {
  keySource: SubagentKeySource; providerId: string | null; groupId: number | null; groupName: string;
  keyId: number | null; keyName: string; maskedKey: string;
  protocol: SubagentProtocol; baseUrl: string; model: string; reasoningEffort: SubagentReasoningEffort;
  enableChunkCompaction: boolean; compactTriggerPct: number; compactKeepRecentGroups: number;
  defaultMode: SubagentMode; maxContextTokens: number; allowModelOverride: boolean; keyStorage: SubagentKeyStorage;
  writeRules: boolean; pythonPath?: string; customInstructions?: string; targets: Record<SubagentHarnessId, boolean>; updatedAt: string | null;
}
export interface SubagentPythonInfo { available: boolean; executable: string | null; version: string | null; meetsMinimum: boolean; error?: string }
export interface SubagentHarnessState {
  id: SubagentHarnessId; name: string; detected: boolean; installed: boolean; rulesInstalled: boolean; supportsRules: boolean;
  installedModel: string | null; installedProtocol: SubagentProtocol | null; mcpPath: string; rulesPath: string | null;
  snippet: string; rulesSnippet: string; notes: string[];
}
export interface SubagentStatus { config: SubagentConfig; python: SubagentPythonInfo; userEnvHasKey: boolean; runtimeScriptPath: string; harnesses: SubagentHarnessState[]; updatedAt: string }
export interface ApplySubagentRequest extends Partial<Pick<SubagentConfig, 'protocol' | 'baseUrl' | 'model' | 'reasoningEffort' | 'defaultMode' | 'maxContextTokens' | 'enableChunkCompaction' | 'compactTriggerPct' | 'compactKeepRecentGroups' | 'allowModelOverride' | 'keyStorage' | 'writeRules' | 'pythonPath' | 'customInstructions'>> {
  providerId?: string; groupId?: number; phuketKeyId?: number; autoCreatePhuketKey?: boolean; apiKey?: string; keepExistingKey?: boolean; targets: SubagentHarnessId[];
}
export interface ApplySubagentResult { status: SubagentStatus; system: SystemApplyResult }
export interface RemoveSubagentRequest { targets: SubagentHarnessId[]; removeRules?: boolean }
export interface SubagentDiffPreview { files: { path: string; before: string | null; after: string | null }[]; warnings: string[] }
export interface SubagentTestRequest { pythonPath?: string; model?: string; protocol?: SubagentProtocol; baseUrl?: string; providerId?: string; apiKey?: string; testUpstream?: boolean }
export interface SubagentTestResult {
  ok: boolean; latencyMs: number; handshakeLatencyMs?: number; pythonExecutable: string | null; pythonVersion: string | null; serverVersion: string | null;
  toolsCount: number; tools: string[]; effectiveModel: string; effectiveProtocol: SubagentProtocol;
  upstreamOk?: boolean | null; upstreamError?: string; error?: string; testedAt: string;
}

export interface PromptPreset {
  id: string;
  name: string;
  appType: AppType;
  content: string;
  enabled: boolean;
}

export interface SkillItem {
  id: string;
  name: string;
  description: string;
  appTypes: AppType[];
  content: string;
  enabled: boolean;
}

/** Metadata for a local snapshot. File contents are never included in a listing. */
export interface ConfigBackupItem {
  id: string;
  appType: AppType;
  createdAt: string;
  reason: string;
  files: string[];
}

/** Text in a preview is redacted. A missing file is null, not an empty file. */
export interface ConfigDiffPreview {
  appType: AppType;
  providerId: string;
  files: { path: string; before: string | null; after: string | null }[];
  warnings: string[];
}

/** User preferences only; secrets and proxy runtime state are not settings. */
export interface AppSettings {
  theme: 'system' | 'light' | 'dark';
  language: 'zh-CN' | 'en';
  backupBeforeSwitch: boolean;
  autoCheckUpdates?: boolean;
  defaultGptFastConfig: GptFastConfig;
}

/** Observed on disk, independent of the desired/current provider in the database. */
export interface LiveCliState {
  appType: AppType;
  detected: boolean;
  configPaths: string[];
  providerId: string | null;
  baseUrl: string | null;
  model: string | null;
  checkedAt: string;
  warnings: string[];
}

/** One initial render without revealing provider credentials. */
export interface OverviewResponse {
  currentProviders: ProviderView[];
  providerCounts: Record<AppType, number>;
  liveCliStates: LiveCliState[];
  proxy: ProxyStatus;
  fastMode: GptFastConfig;
  phuket: PhuketAuthStatus;
  updatedAt: string;
}

/** Detection reads metadata only. Import copies selected entries; never switches an app. */
export interface CcSwitchDetectResult {
  detected: boolean;
  sourcePath: string | null;
  providers: { sourceId: string; name: string; appType: AppType }[];
  warnings: string[];
}

export interface CcSwitchImportRequest { sourceIds?: string[] }

export interface CcSwitchImportResult {
  imported: ProviderView[];
  skipped: { sourceId: string; reason: string }[];
  warnings: string[];
}

export interface HealthResponse {
  ok: true;
  app: 'phuket-switch';
  apiVersion: 1;
}

/** All local control-plane errors use this shape with a non-2xx HTTP status. */
export interface ApiErrorResponse {
  error: { code: string; message: string };
}

export type NoBody = void;
export interface ProviderQuery { appType?: AppType }
export interface PhuketKeysQuery { page?: number; pageSize?: number }
export interface UsageQuery { from?: string; to?: string }
export interface ProxyLogsQuery { cursor?: string; limit?: number }

/** GET inputs are decoded query fields; other inputs are JSON request bodies. */
type Route<Input, Output, Status extends number = 200> = {
  input: Input;
  response: Output;
  status: Status;
};

export interface ApiContract {
  'GET /api/health': Route<NoBody, HealthResponse>;
  'GET /api/network/direct-bypass': Route<NoBody, DirectBypassStatus>;
  'PUT /api/network/direct-bypass': Route<UpdateDirectBypassRequest, DirectBypassStatus>;
  'POST /api/network/direct-bypass/probe': Route<DirectBypassProbeRequest, DirectBypassProbeResult>;
  'GET /api/subagent': Route<NoBody, SubagentStatus>;
  'POST /api/subagent/preview-diff': Route<ApplySubagentRequest, SubagentDiffPreview>;
  'POST /api/subagent/apply': Route<ApplySubagentRequest, ApplySubagentResult>;
  'POST /api/subagent/remove': Route<RemoveSubagentRequest, ApplySubagentResult>;
  'POST /api/subagent/test': Route<SubagentTestRequest, SubagentTestResult>;
  'GET /api/image-prompt': Route<NoBody, ImagePromptStatus>;
  'POST /api/image-prompt/apply': Route<ApplyImagePromptRequest, ApplyImagePromptResult>;
  'POST /api/image-prompt/remove': Route<RemoveImagePromptRequest, ApplyImagePromptResult>;
  'GET /api/overview': Route<NoBody, OverviewResponse>;
  'GET /api/providers': Route<ProviderQuery, ProviderView[]>;
  'POST /api/providers': Route<CreateProviderRequest, ProviderView, 201>;
  'PUT /api/providers/:id': Route<UpdateProviderRequest, ProviderView>;
  'DELETE /api/providers/:id': Route<NoBody, NoBody, 204>;
  'POST /api/providers/:id/activate': Route<ActivateProviderRequest, ActivateProviderResult>;
  'GET /api/providers/:id/preview-diff': Route<NoBody, ConfigDiffPreview>;
  'POST /api/providers/:id/test': Route<NoBody, ProviderTestResult>;
  'GET /api/fast-mode': Route<NoBody, GptFastConfig>;
  'PUT /api/fast-mode': Route<UpdateFastModeRequest, UpdateFastModeResult>;
  'POST /api/fast-mode/setup-ultrafast': Route<SetupUltraFastRequest, SetupUltraFastResult>;
  'GET /api/phuket/status': Route<NoBody, PhuketAuthStatus>;
  'POST /api/phuket/login': Route<PhuketLoginRequest, PhuketAuthStatus>;
  'POST /api/phuket/logout': Route<NoBody, NoBody, 204>;
  'GET /api/phuket/account': Route<NoBody, PhuketAccount>;
  'GET /api/phuket/payment/checkout-info': Route<NoBody, PaymentCheckoutInfo>;
  'POST /api/phuket/payment/orders': Route<CreatePaymentOrderRequest, PaymentOrderResult, 201>;
  'GET /api/phuket/payment/orders': Route<PaymentOrdersQuery, PaymentOrdersPage>;
  'GET /api/phuket/payment/orders/:id': Route<NoBody, PaymentOrderItem>;
  'POST /api/phuket/payment/orders/:id/cancel': Route<NoBody, { ok: true }>;
  'POST /api/phuket/payment/orders/verify': Route<VerifyPaymentOrderRequest, PaymentOrderItem>;
  'POST /api/phuket/redeem': Route<RedeemRequest, RedeemResult>;
  'GET /api/phuket/redeem/history': Route<PaymentPageQuery, RedeemHistoryPage>;
  'GET /api/phuket/groups': Route<NoBody, PhuketGroupsResponse>;
  'GET /api/phuket/keys': Route<PhuketKeysQuery, PhuketKeysPage>;
  'POST /api/phuket/keys': Route<CreatePhuketKeyRequest, CreatePhuketKeyResult, 201>;
  'PUT /api/phuket/keys/:id': Route<UpdatePhuketKeyRequest, PhuketApiKeyView>;
  'DELETE /api/phuket/keys/:id': Route<NoBody, NoBody, 204>;
  'POST /api/phuket/keys/:id/import-provider': Route<ImportPhuketKeyRequest, ProviderView, 201>;
  'GET /api/phuket/usage': Route<UsageQuery, PhuketUsageResponse>;
  'GET /api/monitors': Route<NoBody, ChannelMonitorItem[]>;
  'GET /api/monitors/:id/status': Route<NoBody, ChannelMonitorDetail>;
  'POST /api/monitors/probe-local': Route<LocalProbeRequest, LocalProbeResult>;
  'GET /api/routes': Route<NoBody, ModelRouteRule[]>;
  'PUT /api/routes': Route<UpdateModelRoutesRequest, ModelRouteRule[]>;
  'POST /api/routes/auto-populate': Route<AutoPopulateRoutesRequest, AutoPopulateRoutesResult>;
  'POST /api/routes/sync-codex-catalog': Route<NoBody, SystemApplyResult>;
  'POST /api/routes/clear-codex-catalog': Route<NoBody, SystemApplyResult>;
  'GET /api/proxy/status': Route<NoBody, ProxyStatus>;
  'PUT /api/proxy/settings': Route<ProxySettings, ProxyStatus>;
  'POST /api/proxy/start': Route<NoBody, ProxyStatus>;
  'POST /api/proxy/stop': Route<NoBody, ProxyStatus>;
  'POST /api/proxy/takeover': Route<ProxyTakeoverRequest, ProxyTakeoverResult>;
  'GET /api/proxy/logs': Route<ProxyLogsQuery, ProxyLogsPage>;
  'DELETE /api/proxy/logs': Route<NoBody, NoBody, 204>;
  'POST /api/lab/speed-compare': Route<SpeedCompareRequest, SpeedCompareResult>;
  'GET /api/diagnostics/workbench-models': Route<WorkbenchModelsQuery, WorkbenchModelOption[]>;
  'POST /api/diagnostics/connection': Route<ConnectionCheckRequest, ConnectionCheckResult>;
  'POST /api/lab/chat-test': Route<ChatTestRequest, ChatTestResult>;
  'GET /api/extensions/mcp': Route<NoBody, McpServerItem[]>;
  'POST /api/extensions/mcp': Route<UpsertMcpRequest, McpServerItem>;
  'DELETE /api/extensions/mcp/:target/:name': Route<NoBody, NoBody, 204>;
  'GET /api/extensions/prompts': Route<NoBody, PromptPreset[]>;
  'POST /api/extensions/prompts': Route<CreatePromptRequest, PromptPreset, 201>;
  'PUT /api/extensions/prompts/:id': Route<UpdatePromptRequest, PromptPreset>;
  'DELETE /api/extensions/prompts/:id': Route<NoBody, NoBody, 204>;
  'POST /api/extensions/prompts/:id/apply': Route<NoBody, SystemApplyResult>;
  'GET /api/extensions/skills': Route<NoBody, SkillItem[]>;
  'GET /api/settings': Route<NoBody, AppSettings>;
  'PUT /api/settings': Route<AppSettings, AppSettings>;
  'GET /api/backups': Route<NoBody, ConfigBackupItem[]>;
  'POST /api/backups/:id/restore': Route<NoBody, SystemApplyResult>;
  'GET /api/cc-switch/detect': Route<NoBody, CcSwitchDetectResult>;
  'POST /api/cc-switch/import': Route<CcSwitchImportRequest, CcSwitchImportResult>;
}

export type ApiResponse<R extends keyof ApiContract> = ApiContract[R]['response'];

/** Successful inference returns protocol JSON or an incremental SSE stream. */
type InferenceJson = Record<string, unknown>;
type InferenceOutput = InferenceJson | string;
export interface InferenceContract {
  'POST /claude-desktop/v1/messages': Route<InferenceJson, InferenceOutput>;
  'POST /claude-desktop/v1/messages/count_tokens': Route<InferenceJson, { input_tokens: number }>;
  'GET /claude-desktop/v1/models': Route<NoBody, InferenceJson>;
  'POST /v1/messages': Route<InferenceJson, InferenceOutput>;
  'POST /v1/messages/count_tokens': Route<InferenceJson, { input_tokens: number }>;
  'POST /v1/responses': Route<InferenceJson, InferenceOutput>;
  'POST /v1/chat/completions': Route<InferenceJson, InferenceOutput>;
  'GET /v1/models': Route<NoBody, InferenceJson>;
  'GET /v1beta/models': Route<NoBody, InferenceJson>;
  'GET /v1beta/models/:model': Route<NoBody, InferenceJson>;
  'POST /v1beta/models/:model:generateContent': Route<InferenceJson, InferenceJson>;
  'POST /v1beta/models/:model:streamGenerateContent': Route<InferenceJson, InferenceOutput>;
  'POST /v1beta/models/:model:countTokens': Route<InferenceJson, { totalTokens: number }>;
}

