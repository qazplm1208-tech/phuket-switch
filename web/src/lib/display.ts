import { Activity, Bot, Cable, Gauge, KeyRound, Layers2, Settings2 } from 'lucide-react';
import type {
  AppType,
  ChannelMonitorStatus,
  GptFastConfig,
  PhuketGroup,
  ProtocolType,
  SpeedMode,
  SystemApplyResult,
} from '@shared/types';

export const NAV = [
  { path: '/', name: '供应商', icon: Layers2 },
  { path: '/groups', name: '分组与密钥', icon: KeyRound },
  { path: '/monitor', name: '渠道状态', icon: Activity },
  { path: '/proxy', name: '本地代理', icon: Cable },
  { path: '/lab', name: '检测与测速', icon: Gauge },
  { path: '/subagent', name: '子代理', icon: Bot },
  { path: '/extensions', name: '扩展与设置', icon: Settings2 },
] as const;
export type PagePath = (typeof NAV)[number]['path'];
export const APPS: AppType[] = ['claude', 'codex', 'gemini', 'antigravity', 'gpt-native', 'claude-desktop'];
export const appName: Record<AppType, string> = {
  claude: 'Claude',
  codex: 'Codex',
  'gpt-native': 'Grok · 国产',
  'claude-desktop': 'Claude Desktop',
  gemini: 'Gemini',
  antigravity: '反重力',
};
export const isClaude = (app: AppType) => app === 'claude' || app === 'claude-desktop';
export const hasCliConfig = (app: AppType) => app !== 'gpt-native';
export const protocolName = (p?: ProtocolType | null) =>
  p === 'anthropic-messages' ? 'Anthropic' : p === 'openai-responses' ? 'GPT Responses' : p === 'gemini-native' ? 'Gemini' : '未适配';
export const protocolPath = (p?: ProtocolType | null) =>
  p === 'anthropic-messages' ? '/v1/messages' : p === 'openai-responses' ? '/v1/responses' : p === 'gemini-native' ? '/v1beta/models' : '—';
export const supportedGroup = (g: PhuketGroup) => !!g.protocol && !!g.supportedAppTypes.length;
export const groupApp = (g: PhuketGroup): AppType =>
  g.adapterCategory === 'gemini' || g.adapterCategory === 'antigravity' ? g.adapterCategory : g.adapterCategory === 'claude' ? 'claude' : g.adapterCategory === 'gpt' ? 'codex' : 'gpt-native';
export function saleRate(g: PhuketGroup) {
  const o = g.pricing_offer;
  if (!o?.enabled) return null;
  const now = Date.parse(o.server_time) || Date.now();
  return (!o.starts_at || Date.parse(o.starts_at) <= now) && (!o.ends_at || now < Date.parse(o.ends_at))
    ? o.sale_rate
    : null;
}
export const withSpeedMode = (c: GptFastConfig, mode: SpeedMode): GptFastConfig => ({
  ...c,
  speedMode: mode,
  enabled: mode !== 'standard',
  serviceTier: mode === 'ultrafast' ? 'ultrafast' : mode === 'fast' ? 'priority' : 'default',
  strategy: c.strategy === 'tier_only' ? 'tier_only' : 'hybrid',
});
export const withFastEnabled = (c: GptFastConfig, enabled: boolean): GptFastConfig =>
  withSpeedMode(c, enabled ? 'fast' : 'standard');
const nf = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
export const num = (n?: number | null) => (typeof n === 'number' && Number.isFinite(n) ? nf.format(n) : '—');
export const ms = (n?: number | null) => (n == null ? '—' : `${num(n)} ms`);
export const pct = (n?: number | null) => (n == null ? '—' : `${num(n)}%`);
export const credits = (n?: number | null) => (n == null ? '—' : `${num(n)} credits`);
export function time(v?: string | null, date = false) {
  const d = v ? new Date(v) : null;
  return !d || !Number.isFinite(+d)
    ? '—'
    : date
      ? d.toLocaleString('zh-CN', { hour12: false })
      : d.toLocaleTimeString('zh-CN', { hour12: false });
}
export const statusName: Record<ChannelMonitorStatus, string> = {
  operational: '正常',
  degraded: '波动',
  failed: '异常',
  error: '异常',
  unknown: '未知',
};
export const statusTone = (s?: ChannelMonitorStatus) =>
  s === 'operational'
    ? 'good'
    : s === 'degraded'
      ? 'amber'
      : s === 'failed' || s === 'error'
        ? 'bad'
        : 'muted';
export function systemNote(r?: SystemApplyResult | null) {
  if (!r) return '';
  const n = r.changedPaths.length;
  return [n ? `已写入 ${n} 个文件` : '没有文件变更', r.backupId && '已创建备份', ...(r.warnings ?? [])]
    .filter(Boolean)
    .join(' · ');
}
export function lastWeek() {
  const to = new Date(),
    from = new Date(to);
  from.setDate(from.getDate() - 6);
  const day = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { from: day(from), to: day(to) };
}
