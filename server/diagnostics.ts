import { isWorkbenchChatModel, PHUKET_GPT_BASE_URL, workbenchGroup } from '../shared/constants.js';
import type { ConnectionCheckRequest, ConnectionCheckResult, DiagnosticBalanceCheck, DiagnosticGuidance, LocalCheckStepResult, OnlineCheckStepResult, PhuketApiKeyView } from '../shared/types.js';
import { ApiError, asNumber, now } from './common.js';
import type { SwitchDb } from './db.js';
import { scrub, stepError } from './diagnosticTransport.js';
import type { PhuketClient } from './phuketClient.js';
import type { ProxyServer } from './proxyServer.js';

const unsupported = () => new ApiError(422, 'OPENAI_ONLY', '工作台聊天室在线检测仅支持 OpenAI 接口的模型');
export async function diagnosticKey(phuket: PhuketClient, token: string, keyId: number) {
  if (!token) throw new ApiError(401, 'LOGIN_REQUIRED', '请先登录 PhuketAI。');
  const [{ item, key }, groups] = await Promise.all([phuket.getRawKeyById(token, keyId), phuket.getMergedGroups(token)]);
  const group = workbenchGroup(item, groups);
  if (!group) throw unsupported();
  const media = new Set(groups.find(g => g.id === group.id)?.models.filter(m => m.video_prices && Object.keys(m.video_prices).length).map(m => m.name));
  return { item, key, group, media };
}
const adviceText = {
  online_failed: '在线连接（工作台聊天室）检测失败，说明服务端通道或该密钥当前异常，请联系管理员咨询。',
  local_failed: '工作台在线连接正常，但本地连接失败！请检查本机网络、系统代理或配置，也可直接复制下方错误码联系管理员咨询。',
  passed: '在线连接（工作台聊天室）与本地连接均检测通过，当前通道与本机网络完全正常。',
};
type Recommendation = Pick<ConnectionCheckResult, 'advice' | 'contactAdmin' | 'guidance'>;

async function checkBalance(phuket: PhuketClient, token: string, key: PhuketApiKeyView): Promise<DiagnosticBalanceCheck> {
  const balance = await phuket.getAccount(token, true).then(a => a.balance).catch(() => null);
  const quota = asNumber(key.quota), used = asNumber(key.quota_used);
  const checked = balance !== null && quota !== null && (quota === 0 || used !== null);
  const sufficient = balance !== null && balance > 0 && (quota === 0 || (quota !== null && used !== null && used < quota));
  const quotaText = quota === null ? '未知' : quota === 0 ? '不限额' : `${used ?? '未知'} / ${quota} credits`;
  const summary = `账户余额：${balance === null ? '未能核实' : `${balance} credits`}；密钥额度：${quotaText}`;
  return { checked, accountBalance: balance, keyQuota: quota ?? 0, keyQuotaUsed: used ?? 0, sufficient, summary };
}

async function diagnoseFailure(online: boolean, status: number | null, phuket: PhuketClient, token: string, key: PhuketApiKeyView, groupId: number | null): Promise<Recommendation> {
  function recommend(guidance: DiagnosticGuidance, contactAdmin: boolean, advice = guidance.title) {
    return { guidance, contactAdmin, advice };
  }
  if (status === 403) {
    const balanceCheck = await checkBalance(phuket, token, key);
    const { accountBalance, keyQuota, keyQuotaUsed, checked } = balanceCheck;
    if ((accountBalance !== null && accountBalance <= 0) || (keyQuota > 0 && keyQuotaUsed >= keyQuota)) {
      return recommend({ action: 'recharge', balanceCheck,
        title: online ? '余额或密钥额度不足（403）' : '遇到 403：检测到余额或额度不足',
        steps: online ? ['检测到账户余额或当前密钥额度不足，请先前往「余额充值」后再重新测试。', '若确认余额充足，请联系管理员核查账户状态。']
          : ['已自动检查余额：当前可用余额不足或密钥额度已用尽。', '请先前往「余额充值」补充额度后重新测试。'],
      }, false, online ? undefined : '本地连接返回 403，已自动检查到余额或密钥额度不足，请先充值后再测试。');
    }
    if (!checked) return recommend({ action: 'contact_admin', balanceCheck, title: '遇到 403：未能核实余额或密钥额度', steps: ['请先查看账户余额和当前密钥额度，或复制诊断报告反馈管理员。'] }, true);
    return recommend({ action: 'create_key_and_retest', balanceCheck, recreateGroupId: groupId,
      title: online ? '余额正常但返回 403，建议新建 API 密钥再测试' : '遇到 403：余额正常，请新建 API 密钥再测试',
      steps: online ? ['已自动核验：当前账户余额正常，密钥未超额。', '请点击下方「一键新建密钥并复测」生成同分组新密钥重试；若新密钥仍在线失败，请反馈管理员。']
        : ['已自动检查余额：当前余额充足（无欠费/超额问题）。', '建议点击下方「一键新建密钥并复测」生成新的同分组 API 密钥再测试；若仍失败请携带错误码咨询管理员。'],
    }, true, online ? undefined : '本地连接返回 403，已核验账户余额正常，建议新建一个 API 密钥后再重新测试。');
  }
  if (status === 429) return recommend({ action: 'new_chat_codex_deeplink', title: online ? '触发 429 频率/会话限制' : '遇到 429：请新开对话继续',
    steps: online ? ['请新开一个对话继续使用。', '在 Codex 上可复制当前会话的深度链接（Deep Link）并发送给新对话，即可完整保留历史聊天记录。', '若新开对话后在线检测仍持续 429，请反馈管理员。']
      : ['当前会话或通道触发了 429 限流，请直接新开一个对话。', '在 Codex 中，复制当前会话的深度链接（Deep Link）并发送给新对话，即可保留完整聊天记录！'],
  }, online, '遇到 429 请新开对话；在 Codex 上复制深度链接并发给新对话即可保留聊天记录。');
  if (online) return recommend({ action: 'contact_admin', title: '在线测试异常，请反馈管理员咨询', steps: ['工作台聊天室在线测试未通过，说明服务端上游或通道当前存在异常。', '请点击下方「复制完整诊断报告」反馈给管理员排查。'] }, true, adviceText.online_failed);
  if (status === 502 || status === 503) return recommend({ action: 'check_network', title: '遇到 502 / 503：请检查本机网络', steps: ['工作台在线测试已通过，说明远端模型通道正常。', '本地返回 502 / 503 请优先检查本机网络、系统代理 / 梯子节点稳定性后重试；如果重新测试发现「在线测试」也有问题，请反馈管理员。'] }, false, '在线测试正常，本地返回 502 / 503 请检查本机网络或代理节点（若在线测试也异常请反馈管理员）。');
  return recommend({ action: 'check_network', title: '本地连接失败：请检查网络或配置', steps: ['工作台在线通道正常，但本机请求未成功。', '请核对下方贴出的错误码并检查网络/本地代理；如需协助请复制错误码反馈管理员。'] }, true, adviceText.local_failed);
}

function reportStep(name: string, step: OnlineCheckStepResult | LocalCheckStepResult) {
  const e = step.error;
  return [`${name}：${{ passed: '通过', failed: '失败', skipped: '已跳过' }[step.status]}`, `检测地址：${step.endpoint}`,
    ...(step.latencyMs !== null ? [`耗时：${step.latencyMs} ms`] : []),
    ...(e ? [`错误码：${e.code}`, `HTTP 状态：${e.httpStatus ?? '无'}`, `网络错误：${e.networkCode ?? '无'}`, `上游错误：${[e.upstreamType,e.upstreamCode].filter(Boolean).join(' · ') || '无'}`, `详细信息：${e.message}`] : [])];
}
export async function runConnectionCheck(db: SwitchDb, phuket: PhuketClient, proxy: ProxyServer, token: string, req: ConnectionCheckRequest): Promise<ConnectionCheckResult> {
  const startedAt = now(), { item, key, group, media } = await diagnosticKey(phuket, token, req.keyId);
  if (!isWorkbenchChatModel(req.model) || media.has(req.model)) throw unsupported();
  const target = req.localTarget ?? 'direct';
  const provider = target === 'direct' && req.providerId ? db.provider(req.providerId) : null;
  if (provider && provider.protocol !== 'openai-responses') throw unsupported();
  const online = await phuket.runWorkbenchChatCheck(token, req.keyId, req.model);
  const { running, settings } = proxy.getStatus();
  const endpoint = target === 'proxy' ? `http://${settings.host}:${settings.port}/v1/responses` : `${(provider?.baseUrl ?? PHUKET_GPT_BASE_URL).replace(/\/+$/, '')}/responses`;
  let local: LocalCheckStepResult = { status: 'skipped', ok: false, latencyMs: null, firstTokenMs: null, target, endpoint, model: req.model };
  if (online.ok) {
    if (target === 'proxy' && !running) local = { ...local, status: 'failed', latencyMs: 0, error: stepError('PROXY_NOT_RUNNING', '本地代理服务未启动（请先在「本地代理」启动服务，或切换为「本机直连 API」测试）') };
    else local = { target, ...await phuket.runLocalConnectionCheck(endpoint, target === 'proxy' ? 'local-diagnostics' : provider?.apiKey ?? key, req.model) };
  }
  const overallStatus = !online.ok ? 'online_failed' : !local.ok ? 'local_failed' : 'passed';
  const groupId = item.group_id ?? group.id ?? null;
  const { advice, guidance, contactAdmin }: Recommendation = overallStatus === 'passed'
    ? { advice: adviceText.passed, contactAdmin: false }
    : await diagnoseFailure(!online.ok, (online.ok ? local : online).error?.httpStatus ?? null, phuket, token, item, groupId);
  const finishedAt = now(), keyName = item.name || `密钥 ${req.keyId}`, groupName = group.name;
  const diagnosticReport = [`连接检测 · ${startedAt}`, `密钥：${keyName} · 分组：${groupName}`, `模型：${req.model}`, ...reportStep('工作台在线连接', online), ...reportStep(target === 'proxy' ? '本地代理' : '本机直连 API', local), advice,
    ...(guidance ? [`排查建议：${guidance.title}`, ...(guidance.balanceCheck ? [guidance.balanceCheck.summary] : []), ...guidance.steps] : [])].join('\n');
  const result: ConnectionCheckResult = { startedAt, finishedAt, overallStatus, contactAdmin, advice, guidance, keyId: req.keyId, keyName, groupId, groupName, model: req.model, online, local, diagnosticReport };
  // Upstream metadata, previews and error codes are all untrusted, not just error.message.
  const stored = db.state('phuketSession');
  const secrets = [key, token, provider?.apiKey ?? '', stored?.token ?? '', stored?.refreshToken ?? ''];
  return JSON.parse(JSON.stringify(result, (_, value: unknown) => typeof value === 'string' ? scrub(value, secrets) : value));
}
