import { z } from 'zod';
import { isIP } from 'node:net';
import { directBypassModes, paymentStatuses, subagentHarnessIds, subagentProtocols } from '../shared/types.js';
import { apps } from './db.js';
import { MODEL_SLUG } from '../shared/constants.js';
import { httpBase, normalizeLoginEmail, normalizeLoginPassword, normalizeLoginToken } from './common.js';

export const appType = z.enum(apps), target = z.enum(['claude','codex']);
const text = z.string().trim().min(1).max(512).regex(/^[^\r\n\0]+$/);
const model = text.max(256), protocol = z.enum(['anthropic-messages','openai-responses','gemini-native']);
const safeKey = z.string().min(1).max(256).refine(k => !['__proto__','constructor','prototype'].includes(k) && !/[\r\n\0]/.test(k));
export const fast = z.strictObject({
  enabled: z.boolean(), serviceTier: z.enum(['default','auto','priority','fast','ultrafast','flex']), strategy: z.enum(['tier_only','fast_suffix','hybrid']),
  reasoningEffort: z.enum(['none','low','medium','high','xhigh','max','ultra']).optional(), injectCodexCatalogFast: z.boolean(), fastModelMap: z.record(safeKey, model),
  speedMode: z.enum(['standard','fast','ultrafast']).optional(), ultraFastProviderId: text.nullable().optional(), respectClientServiceTier: z.boolean().optional(), catalogSpeedVariants: z.boolean().optional(),
});
const claudeMap = z.strictObject({ defaultModel: model, sonnet: model, haiku: model, opus: model }).partial();
const provider = z.strictObject({ appType, name: text, protocol, baseUrl: z.string().max(4096).refine(httpBase), apiKey: z.string().min(1).max(16384).regex(/^[\x21-\x7e]+$/).optional(), phuketKeyId: z.int().positive().optional(), autoCreatePhuketKey: z.boolean().optional(), phuketGroupId: z.int().positive().optional(), phuketGroupName: text.optional(), phuketPlatform: text.optional(), rateMultiplier: z.number().nonnegative().optional(), model: model.optional(), claudeModelMap: claudeMap.optional(), codexFastConfig: fast.optional(), availableModels: z.array(model).max(4096).optional(), inFailoverQueue: z.boolean().optional(), priority: z.int().optional(), notes: z.string().max(8192).optional() });
const sourceCount = (r: { apiKey?: string; phuketKeyId?: number; autoCreatePhuketKey?: boolean }) =>
  Number(r.apiKey !== undefined) + Number(r.phuketKeyId !== undefined) + Number(r.autoCreatePhuketKey === true);
export const setupUltraFast = z.strictObject({
  groupId: z.int().positive().optional(), phuketKeyId: provider.shape.phuketKeyId, autoCreatePhuketKey: provider.shape.autoCreatePhuketKey,
  apiKey: provider.shape.apiKey, applyToCodex: z.boolean().optional(), enableCodexMenu: z.boolean().optional(),
}).refine(r => sourceCount(r) <= 1, { message: '不能同时指定多个密钥来源。' });
const imagePromptModel = model.regex(MODEL_SLUG);
export const applyImagePrompt = z.strictObject({
  groupId: z.int().positive().optional(),
  defaultModel: imagePromptModel.optional(),
  models: z.array(imagePromptModel).max(128).optional(),
  targets: z.array(target).min(1).max(2).transform(a => [...new Set(a)]),
  phuketKeyId: z.int().positive().optional(),
  autoCreatePhuketKey: z.boolean().optional(),
  apiKey: z.string().min(1).max(16384).regex(/^[\x21-\x7e]+$/).optional(),
  customInstructions: z.string().max(8192).optional(),
}).superRefine((r, ctx) => {
  if (sourceCount(r) > 1) ctx.addIssue({ code: 'custom', message: '不能同时指定多个密钥来源。' });
});
export const removeImagePrompt = z.strictObject({
  targets: z.array(target).min(1).max(2).transform(a => [...new Set(a)]),
});
export const updateDirectBypass = z.strictObject({
  enabled: z.boolean(), mode: z.enum(directBypassModes), interfaceName: z.string().max(128).regex(/^[^\x00-\x1f\x7f-\x9f]*$/).transform(s => s.trim()),
  dnsServers: z.array(z.string().max(64).refine(s => !!isIP(s) && !s.includes('%'), 'DNS 服务器必须是 IPv4 或 IPv6 地址。')).max(4, '最多可指定 4 个 DNS 服务器。'), applyToSubagent: z.boolean(),
}).partial();
export const directBypassProbe = z.strictObject({ url: z.string().max(4096).refine(s => {
  const url = URL.parse(s);
  return !!url && /^https?:\/\/[^/@?#]+(?:[/?#]|$)/i.test(s) && !/[\s\\\x00-\x1f\x7f]/.test(s) && !url.username && !url.password;
}, '测试地址必须是无用户名和密码的 HTTP 或 HTTPS 网址。').optional() });

const subagentTargets = z.array(z.enum(subagentHarnessIds)).min(1).max(9).transform(a => [...new Set(a)]);
const subagentFields = {
  pythonPath: z.string().trim().max(4096).regex(/^[^\r\n\0]*$/).optional(), model: model.regex(MODEL_SLUG).optional(),
  protocol: z.enum(subagentProtocols).optional(), baseUrl: provider.shape.baseUrl.optional(), providerId: text.optional(), apiKey: provider.shape.apiKey,
};
export const testSubagent = z.strictObject({ ...subagentFields, testUpstream: z.boolean().optional() });
export const removeSubagent = z.strictObject({ targets: subagentTargets, removeRules: z.boolean().optional() });
export const applySubagent = z.strictObject({
  ...subagentFields, targets: subagentTargets, groupId: z.int().positive().optional(), phuketKeyId: provider.shape.phuketKeyId,
  autoCreatePhuketKey: z.boolean().optional(), keepExistingKey: z.boolean().optional(),
  reasoningEffort: z.enum(['none','low','medium','high','xhigh','max']).optional(), defaultMode: z.enum(['edit','readonly']).optional(),
  enableChunkCompaction: z.boolean().optional(), compactTriggerPct: z.number().int().min(40).max(95).optional(), compactKeepRecentGroups: z.number().int().min(0).max(20).optional(),
  maxContextTokens: z.int().min(5712).max(272000).optional(), allowModelOverride: z.boolean().optional(),
  keyStorage: z.enum(['user-env','mcp-env']).optional(), writeRules: z.boolean().optional(),
  customInstructions: z.string().max(8192).refine(s => !s.includes('PHUKET_SWITCH_SUBAGENT_')).optional(),
}).refine(r => sourceCount(r) + Number(!!r.providerId) <= 1 && (!r.autoCreatePhuketKey || !!r.groupId), { message: 'Choose one credential source; creating a key requires a group.' });
export const createProvider = provider.superRefine((r, ctx) => {
  if (sourceCount(r) !== 1) ctx.addIssue({ code: 'custom', message: '请选择一种密钥来源。' });
  if (r.autoCreatePhuketKey && !r.phuketGroupId) ctx.addIssue({ code: 'custom', path: ['phuketGroupId'], message: '自动新建密钥需要选择 PhuketAI 分组。' });
});
export const updateProvider = provider.omit({ appType: true }).partial().extend({ codexFastConfig: fast.nullish(), phuketGroupId: provider.shape.phuketGroupId.nullable() }).superRefine((r, ctx) => {
  if (r.phuketGroupId === null && (r.phuketKeyId !== undefined || r.autoCreatePhuketKey)) ctx.addIssue({ code: 'custom', message: '自定义供应商不支持分组密钥。' });
  if (sourceCount(r) > 1) ctx.addIssue({ code: 'custom', message: '不能同时指定多个密钥来源。' });
});
export const activate = z.strictObject({ applyToSystem: z.boolean().optional() });
export const providerQuery = z.strictObject({ appType: appType.optional() });
export const updateFastMode = z.strictObject({ config: fast, applyToCodex: z.boolean().optional() });
export const login = z.strictObject({
  email: z.string().transform(normalizeLoginEmail).pipe(z.string().max(320).regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, '请输入有效的邮箱地址。')).optional(),
  password: z.string().max(4096).transform(normalizeLoginPassword).pipe(z.string().min(1, '请输入密码。')).optional(),
  totpCode: z.string().trim().regex(/^\d{6}$/, '请输入6位动态验证码。').optional(),
  tempToken: z.string().trim().min(1).max(16384).optional(),
  token: z.string().max(16512).transform(normalizeLoginToken).pipe(z.string().min(1, '请输入有效的登录 Token。').max(16384)).optional(),
  refreshToken: z.string().max(16384).refine(v => !/[\r\n]/.test(v), '刷新令牌不能包含换行。').trim().min(1).refine(v => !/^sk-/i.test(v), 'API 密钥不能用作刷新令牌。').optional(),
  acceptAgreement: z.boolean().optional(),
}).superRefine((r, ctx) => {
  const credentials = r.email !== undefined && r.password !== undefined;
  const twoFactor = r.tempToken !== undefined && r.totpCode !== undefined;
  if (r.refreshToken !== undefined && r.token === undefined) ctx.addIssue({ code: 'custom', path: ['refreshToken'], message: '刷新令牌仅用于 Token 登录。' });
  const modes = Number(r.token !== undefined) + Number(credentials) + Number(twoFactor);
  if (modes !== 1) ctx.addIssue({ code: 'custom', message: '请选择邮箱密码登录、两步验证或 Token 登录。' });
  if ((r.email === undefined) !== (r.password === undefined)) ctx.addIssue({ code: 'custom', message: '邮箱和密码必须同时填写。' });
  if ((r.tempToken === undefined) !== (r.totpCode === undefined)) ctx.addIssue({ code: 'custom', message: '两步验证需要临时 Token 和 6 位动态验证码。' });
});
export const keyPage = z.strictObject({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20) });
export const paymentPage = z.strictObject({ page: keyPage.shape.page, page_size: keyPage.shape.pageSize });
export const ordersQuery = paymentPage.extend({ status: z.enum(paymentStatuses).optional() });
export const createOrder = z.strictObject({ amount: z.number().positive(), payment_type: text, order_type: z.enum(['balance','subscription']), plan_id: z.int().positive().optional() });
export const verifyOrder = z.strictObject({ out_trade_no: text });
export const redeem = z.strictObject({ code: text });
export const createKey = z.strictObject({ name: text, group_id: z.int().positive(), quota: z.number().nonnegative().optional(), expires_at: z.iso.datetime({ offset: true }).nullable().optional() });
export const updateKey = createKey.partial().extend({ status: z.enum(['active','inactive']).optional() });
export const importKey = z.strictObject({ appType: appType.optional(), name: text.optional(), model: model.optional() });
const date = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);
export const usageQuery = z.strictObject({ from: date.optional(), to: date.optional() }).refine(q => !q.from || !q.to || Date.parse(q.from) <= Date.parse(q.to));
export const updateModelRoutes = z.strictObject({ rules: z.array(z.strictObject({
  id: text.optional(), enabled: z.boolean(), sourceClient: target,
  sourceModel: z.union([z.literal('*'), z.string().regex(MODEL_SLUG)]),
  targetProviderId: text, targetModel: model, note: z.string().max(8192).optional(),
})) });
export const autoPopulateRoutes = z.strictObject({ sourceClient: z.enum(['all', 'claude', 'codex']).optional(), syncCodexCatalog: z.boolean().optional() });
export const proxySettings = z.strictObject({ host: z.literal('127.0.0.1'), port: z.int().min(1).max(65535), failoverEnabled: z.boolean(), requestTimeoutMs: z.int().min(1).max(600000), logRequests: z.boolean() });
export const takeover = z.strictObject({ appType, enable: z.boolean() });
export const logs = z.strictObject({ cursor: text.optional(), limit: z.coerce.number().int().min(1).max(1000).optional() });
export const probe = z.strictObject({ providerId: text, model: model.optional() });
export const chat = probe.extend({ prompt: z.string().min(1).max(128000), fastConfig: fast.optional(), maxOutputTokens: z.int().min(1).max(32768).optional() });
export const compare = chat.extend({ runs: z.int().min(1).max(10).optional(), prompt: chat.shape.prompt.optional() });
const dictionary = z.record(safeKey, z.string().max(16384));
const stdio = z.strictObject({ type: z.literal('stdio'), command: text, args: z.array(z.string().max(8192)).max(512), env: dictionary.optional() });
const remote = z.strictObject({ type: z.enum(['sse','http']), url: z.httpUrl().max(4096), headers: dictionary.optional() });
export const mcp = z.strictObject({ name: safeKey, target, enabled: z.boolean().optional(), transport: z.union([stdio, remote]) });
export const mcpName = safeKey;
export const prompt = z.strictObject({ name: text, appType: target, content: z.string().min(1).max(512 * 1024) });
export const updatePrompt = prompt.omit({ appType: true }).partial();
export const settings = z.strictObject({ theme: z.enum(['system','light','dark']), language: z.enum(['en','zh-CN']), backupBeforeSwitch: z.boolean(), autoCheckUpdates: z.boolean().optional(), defaultGptFastConfig: fast });
export const importCc = z.strictObject({ sourceIds: z.array(text).max(10000).optional() });
export const numericId = z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.int().positive());
export const workbenchModels = z.strictObject({ keyId: numericId });
export const connectionCheck = z.strictObject({ keyId: z.int().positive(), providerId: text.optional(), model: model.regex(MODEL_SLUG), localTarget: z.enum(['direct','proxy']).optional() });
