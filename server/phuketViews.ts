import type { ChannelMonitorDetail, ChannelMonitorItem, ChannelMonitorModelDetail, ChannelMonitorTimelinePoint, KeyUsageSnapshot, PhuketAccount, PhuketApiKeyView, PhuketGroupMetadata, PhuketGroupModel, PhuketKeyUsage, PhuketModelPricing, PhuketModelUsage, PhuketOperatingAccess, PhuketPricingInterval, PhuketPricingOffer, PhuketUsageLog, PhuketUsageStats, PhuketUsageTrendPoint } from '../shared/types.js';
import { asNumber, isRecord, own, pick, upstreamError } from './common.js';
import type { PaymentCheckoutInfo, PaymentOrderItem, PaymentOrdersPage, RedeemHistoryItem } from '../shared/types.js';
import { safePaymentUrl } from '../shared/payment.js';
import { maskApiKey } from './db.js';

export function rows(value: unknown, ...keys: string[]): Record<string, any>[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  for (const k of [...keys, 'items', 'list', 'data']) if (Array.isArray(own(value)[k])) return own(value)[k].filter(isRecord);
  return [];
}
export function checkoutInfo(v: unknown): PaymentCheckoutInfo {
  if (!isRecord(v) || !isRecord(v.methods) || typeof v.recharge_fee_rate !== 'number') throw upstreamError();
  return { ...pick<PaymentCheckoutInfo>(v, ['global_min','global_max','plans','balance_disabled','balance_recharge_multiplier','recharge_fee_rate','recharge_bonus_tiers','recharge_bonus_mode','recharge_bonus_notice','help_text','alipay_force_qrcode']),
    methods: Object.fromEntries(Object.entries(v.methods).map(([key, method]) => [key, pick<PaymentCheckoutInfo['methods'][string]>(method, ['payment_type','currency','fee_rate','daily_limit','single_min','single_max'])])) };
}
export function paymentOrder(v: unknown): PaymentOrderItem {
  const row = own(v), id = asNumber(row.order_id ?? row.id);
  if (id === null || !Number.isSafeInteger(id) || id <= 0 || typeof row.status !== 'string' || typeof row.out_trade_no !== 'string') throw upstreamError();
  return { ...pick<PaymentOrderItem>(row, ['out_trade_no','amount','pay_amount','payment_type','payment_mode','currency','qr_code','expires_at','created_at']),
    id, order_id: id, status: row.status.toUpperCase(), pay_url: safePaymentUrl(row.pay_url) };
}
export function paymentOrders(v: unknown): PaymentOrdersPage {
  if (!Array.isArray(own(v).items)) throw upstreamError();
  return { ...pick<PaymentOrdersPage>(v, ['total','page','page_size','pages']), items: rows(v).map(paymentOrder) };
}
export function redeemHistory(v: unknown) {
  if (!Array.isArray(own(v).items)) throw upstreamError();
  return { ...pick<{ total?: number }>(v, ['total']), items: rows(v).map(row => ({
    ...pick<RedeemHistoryItem>(row, ['id','type','value','status','used_at','created_at','group_id','validity_days']),
    ...(typeof row.code === 'string' ? { code: row.code.length > 8 ? `••••${row.code.slice(-4)}` : '••••' } : {}),
  })) };
}
export function account(value: unknown): PhuketAccount {
  if (asNumber(own(value).id) === null || typeof own(value).email !== 'string') throw upstreamError();
  return { username: '', role: '', status: '', balance: 0, frozen_balance: 0, total_recharged: 0, concurrency: 0, rpm_limit: 0, allowed_groups: null, created_at: '', ...pick<Partial<PhuketAccount>>(value, ['id','email','username','role','status','balance','frozen_balance','total_recharged','concurrency','rpm_limit','allowed_groups','avatar_url','last_active_at','created_at']) } as PhuketAccount;
}
function access(v: unknown): PhuketOperatingAccess {
  return { allowed: false, reason: '', model_restrictions: false, allowed_models: null, denied_models: null, ...pick<Partial<PhuketOperatingAccess>>(v, ['allowed','reason','model_restrictions','allowed_models','denied_models']) };
}
const tokenPrices = ['input_price','output_price','cache_write_price','cache_write_1h_price','cache_write_12h_price','cache_read_price'] as const;
function pricing(v: unknown, official = false) {
  if (!isRecord(v)) return null;
  const p = pick<PhuketModelPricing>(v, official ? tokenPrices : [...tokenPrices,'billing_mode','image_input_price','image_output_price','per_request_price','reasoning_effort_multipliers']);
  if (v.intervals || !official) p.intervals = rows(v.intervals).map(i => pick<PhuketPricingInterval>(i, [...tokenPrices,'min_tokens','max_tokens','tier_label','input_multiplier','output_multiplier','cache_write_multiplier','cache_read_multiplier','per_request_price']));
  return p;
}
export function groupModel(v: Record<string, any>): PhuketGroupModel {
  return { ...pick<PhuketGroupModel>(v, ['name','platform','long_context_basis','video_prices']), operating_access: v.operating_access ? access(v.operating_access) : null, pricing: pricing(v.pricing), official_pricing: pricing(v.official_pricing, true) };
}
export function metadata(v: unknown): PhuketGroupMetadata {
  const r = own(v);
  const result = { name: '', platform: '', description: '', status: 'unknown', is_exclusive: false, rate_multiplier: 1, ...pick<Partial<PhuketGroupMetadata>>(r, ['name','platform','description','status','is_exclusive','claude_code_only','rate_multiplier','standard_rate_multiplier']), id: Number(r.id) };
  result.name = typeof result.name === 'string' ? result.name.trim() : '';
  return { ...result, ...('operating_access' in r ? { operating_access: r.operating_access ? access(r.operating_access) : null } : {}), ...('pricing_offer' in r ? { pricing_offer: r.pricing_offer ? pick<PhuketPricingOffer>(r.pricing_offer, ['group_id','group_name','standard_rate','sale_rate','enabled','starts_at','ends_at','revision','server_time']) : null } : {}) };
}
export function keyView(raw: unknown, usage?: PhuketKeyUsage): PhuketApiKeyView {
  const v = own(raw);
  const display = String(v.key_display || '');
  const mask = typeof v.key === 'string' && v.key ? maskApiKey(v.key) : /\.{3}|\*{3,}|\u2026/.test(display) ? display : maskApiKey(display);
  return { ...pick<PhuketApiKeyView>(v, ['id','user_id','name','managed_trial','group_id','status','ip_whitelist','ip_blacklist','last_used_at','last_used_ip','current_concurrency','quota','quota_used','expires_at','rate_limit_5h','rate_limit_1d','rate_limit_7d','usage_5h','usage_1d','usage_7d','window_5h_start','window_1d_start','window_7d_start','reset_5h_at','reset_1d_at','reset_7d_at','created_at','updated_at','today_actual_cost','total_actual_cost']), ...(v.group !== undefined ? { group: v.group ? metadata(v.group) : null } : {}), ...(usage ? { today_actual_cost: usage.today_actual_cost, total_actual_cost: usage.total_actual_cost } : {}), key_display: mask || '****' };
}
export function keyCosts(v: unknown): PhuketKeyUsage[] {
  const source = own(v).usage ?? own(v).usages ?? v;
  const list = rows(source, 'api_keys','stats');
  return (list.length ? list : Object.entries(own(source)).filter(([k, val]) => /^\d+$/.test(k) && isRecord(val)).map(([id, val]) => ({ api_key_id: Number(id), ...val }))).map(v => pick<PhuketKeyUsage>(v, ['api_key_id','today_actual_cost','total_actual_cost']));
}
export function keySnapshot(value: unknown): KeyUsageSnapshot {
  if (!isRecord(value)) throw upstreamError();
  const usage = own(value.usage ?? value.stats), today = own(usage.today ?? value.today), total = own(usage.total ?? value.total), plan = own(value.subscription ?? value.plan);
  return { balance: asNumber(value.balance), remaining: asNumber(value.remaining ?? value.remaining_quota ?? value.balance), unit: typeof value.unit === 'string' ? value.unit : 'USD', planName: value.planName ?? value.plan_name ?? plan.plan_name ?? plan.name ?? (typeof value.plan === 'string' ? value.plan : null),
    todayRequests: asNumber(today.requests ?? today.total_requests ?? value.today_requests ?? value.todayRequests), todayTokens: asNumber(today.tokens ?? today.total_tokens ?? value.today_tokens ?? value.todayTokens), todayActualCost: asNumber(today.actual_cost ?? today.total_actual_cost ?? value.today_actual_cost ?? value.todayActualCost),
    totalRequests: asNumber(total.requests ?? total.total_requests ?? value.total_requests ?? value.totalRequests), totalTokens: asNumber(total.tokens ?? total.total_tokens ?? value.total_tokens ?? value.totalTokens), totalActualCost: asNumber(total.actual_cost ?? total.total_actual_cost ?? value.total_actual_cost ?? value.totalActualCost) };
}
export const stats = (v: unknown) => pick<PhuketUsageStats>(v, ['total_api_keys','active_api_keys','total_requests','today_requests','total_tokens','today_tokens','total_input_tokens','today_input_tokens','total_output_tokens','today_output_tokens','total_cache_creation_tokens','today_cache_creation_tokens','total_cache_read_tokens','today_cache_read_tokens','total_cost','today_cost','total_actual_cost','today_actual_cost','average_duration_ms','rpm','tpm']);
const totals = ['requests','input_tokens','output_tokens','cache_creation_tokens','cache_read_tokens','total_tokens','cost','actual_cost'] as const;
export const trend = (v: unknown) => rows(v, 'trend','trends','points').map(r => pick<PhuketUsageTrendPoint>(r, [...totals,'date']));
export const modelUsage = (v: unknown) => rows(v, 'models','model_stats').map(r => pick<PhuketModelUsage>(r, [...totals,'model']));
export const usageLogs = (v: unknown) => rows(v, 'logs').map(r => pick<PhuketUsageLog>(r, ['id','api_key_id','model','input_tokens','output_tokens','actual_cost','duration_ms','created_at']));
const monitorFields = ['id','name','provider','group_id','group_name'] as const;
export const monitors = (v: unknown) => rows(v,'monitors','channels').map(r => ({ ...pick<ChannelMonitorItem>(r, [...monitorFields,'group_rate_multiplier','primary_model','primary_status','primary_latency_ms','primary_ping_latency_ms','availability_7d']), extra_models: rows(r.extra_models).map(m => pick<ChannelMonitorItem['extra_models'][number]>(m, ['model','status','latency_ms'])), timeline: rows(r.timeline).map(t => pick<ChannelMonitorTimelinePoint>(t, ['checked_at','status','latency_ms','ping_latency_ms'])) }));
export const monitorDetail = (v: unknown) => ({ ...pick<ChannelMonitorDetail>(v, monitorFields), models: rows(own(v).models).map(m => pick<ChannelMonitorModelDetail>(m, ['model','latest_status','latest_latency_ms','availability_7d','availability_15d','availability_30d','avg_latency_7d_ms'])) });
