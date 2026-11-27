import { useId, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Eye, EyeOff, KeyRound, LogIn } from 'lucide-react';
import { allowedGroupModels, DEFAULT_PROXY_PORT, isAstraModel, isOnlyAstraGroup, MAX_SUBAGENT_CONTEXT_TOKENS, MIN_SUBAGENT_CONTEXT_TOKENS, MODEL_SLUG, providerModelNames } from '@shared/constants';
import { subagentProtocols, type PhuketApiKeyView, type PhuketGroup, type ProviderView, type SubagentStatus } from '@shared/types';
import { appName } from '../lib/display';
import { endpointPresets, fallbacks, groupDefaults, maskOnly, needsOriginKey, origin, protocols, providerDefaults, resolvedEndpointPreview, triggerTokenHint, type Draft } from '../lib/subagent';
import { useStudio } from '../lib/studio';
import { Btn, Choices, Disclosure, Empty, Field, IconBtn, Notice, Section, Toggle } from './ui';

function SecretField({ label, hint, secret, setSecret }: { label: string; hint?: string; secret: string; setSecret: (v: string) => void }) {
  const [visible, setVisible] = useState(false), input = useRef<HTMLInputElement>(null), hintId = useId();
  // Sync the live input property without copying the key into a serializable HTML attribute.
  useLayoutEffect(() => { if (input.current && input.current.value !== secret) input.current.value = secret; }, [secret]);
  return <div className="subagent-secret-field">
    <Field label={label}><input ref={input} type={visible ? 'text' : 'password'} autoComplete="off" spellCheck={false} maxLength={16384}
      placeholder="输入密钥" aria-describedby={hint ? hintId : undefined} onChange={e => setSecret(e.target.value)} /></Field>
    <IconBtn icon={visible ? EyeOff : Eye} label={`${visible ? '隐藏' : '显示'}${label}`} aria-pressed={visible} onClick={() => setVisible(v => !v)} />
    {hint && <small id={hintId}>{hint}</small>}
  </div>;
}

const sources = [['provider','已有供应商'], ['phuket-group','PhuketAI 分组'], ['manual','手动 / 环境变量']] as const;
interface Props {
  d: Draft; status: SubagentStatus; edit: (patch: Partial<Draft>) => void; busy: boolean;
  groups: PhuketGroup[]; activeKeys: PhuketApiKeyView[]; groupsLoading: boolean; keysLoading: boolean;
  groupsError: boolean; keysError: boolean; reloadGroups: () => void; reloadKeys: () => void;
  provider?: ProviderView; group?: PhuketGroup; secret: string; setSecret: (key: string) => void; secretEpoch: number;
}
export default function SubagentConfigPanel({ d, status, edit, busy, groups, activeKeys, groupsLoading, keysLoading, groupsError, keysError, reloadGroups, reloadKeys, provider, group, secret, setSecret, secretEpoch }: Props) {
  const s = useStudio(), providers = s.providers.data ?? [], [allModels, setAllModels] = useState(false);
  const localProxyUrl = `http://127.0.0.1:${s.proxy?.settings.port ?? DEFAULT_PROXY_PORT}`;
  const originKey = needsOriginKey(d, status, provider), endpoint = resolvedEndpointPreview(d.baseUrl, d.protocol, d.model);
  const picks = [...new Set([...(originKey ? [] : d.source === 'provider' && provider ? providerModelNames(provider) : d.source === 'phuket-group' ? allowedGroupModels(group) : []), ...fallbacks[d.protocol]])].filter(m => MODEL_SLUG.test(m));
  const preferAstra = d.source === 'phuket-group' && isAstraModel(d.model);
  const groupOptions = preferAstra ? [...groups].sort((a, b) => Number(isOnlyAstraGroup(b)) - Number(isOnlyAstraGroup(a))) : groups;
  const source = (v: Draft['source']) => {
    if (v === d.source) return;
    const p = provider ?? providers.find(p => p.isCurrent) ?? providers[0], g = group ?? groups[0];
    edit({ source: v, ...(v === 'provider' && p ? providerDefaults(p) : v === 'phuket-group' && g ? groupDefaults(g) : {}) });
    setAllModels(false);
  };
  return <section className="card padded subagent-panel" aria-label="自定义模型与凭据">
    <Section title="自定义模型与凭据" />
    <fieldset className="subagent-fields" disabled={busy}>
      <div className="subagent-source"><span className="subagent-label">凭据来源</span><Choices label="凭据来源" items={sources} value={d.source} change={source} disabled={busy} /></div>
      {d.source === 'provider' && <>
        {s.providers.error && <Notice retry={s.providers.reload}>未能读取供应商列表。</Notice>}
        {!providers.length && !s.providers.loading ? <Empty title="暂无已保存的供应商" action={<Btn onClick={() => s.navigate('/')}>前往供应商</Btn>} /> : <Field label="已有供应商">
          <select value={d.providerId} onChange={e => { const p = providers.find(p => p.id === e.target.value); if (p) { edit(providerDefaults(p)); setAllModels(false); } }}>
            <option value="" disabled>{s.providers.loading ? '正在读取供应商…' : '请选择供应商'}</option>
            {d.providerId && !provider && <option value={d.providerId} disabled>原供应商已不可用</option>}
            {providers.map(p => <option key={p.id} value={p.id}>{p.name} · {appName[p.appType]} · {protocols[p.protocol][0]}{p.model ? ` · ${p.model}` : ''} · {maskOnly(p.maskedKey) || '无密钥'}</option>)}
          </select></Field>}
      </>}
      {d.source === 'phuket-group' && <>
        {!s.session?.authenticated && <Notice>登录后可选择或新建分组密钥。 <Btn icon={LogIn} onClick={() => s.setLogin(true)}>登录 PhuketAI</Btn></Notice>}
        {groupsError && <Notice retry={reloadGroups}>未能读取推理分组。</Notice>}
        {keysError && <Notice retry={reloadKeys}>未能读取账号密钥。</Notice>}
        <div className="form-grid">
          <Field label="推理分组" hint={preferAstra ? 'Astra 模型可选 Only astra 分组；使用本地代理时可自动按模型分流。' : undefined}><select value={d.groupId} onChange={e => { const g = groups.find(g => String(g.id) === e.target.value); if (g) { edit(groupDefaults(g)); setAllModels(false); } }}>
            <option value="" disabled>{groupsLoading ? '正在读取分组…' : groups.length ? '请选择推理分组' : '暂无可用推理分组'}</option>
            {d.groupId && !group && <option value={d.groupId} disabled>原分组已不可用</option>}
            {groupOptions.map(g => <option key={g.id} value={g.id}>{g.name} · {preferAstra && isOnlyAstraGroup(g) ? `仅 Astra · ${g.rate_multiplier}x` : protocols[g.protocol!][0]}</option>)}
          </select></Field>
          <Field label="分组密钥" hint={keysLoading ? '正在读取账号密钥…' : '仅列出此分组当前有效的密钥。'}><select value={d.keyChoice} disabled={!group || !s.session?.authenticated} onChange={e => edit({ keyChoice: e.target.value })}>
            <option value="auto">自动复用或新建</option><option value="create">新建专用密钥</option>
            {d.keyChoice.startsWith('key:') && !activeKeys.some(k => `key:${k.id}` === d.keyChoice) && <option value={d.keyChoice} disabled>原密钥不在当前列表</option>}
            {activeKeys.map(k => <option key={k.id} value={`key:${k.id}`}>{k.name} · {maskOnly(k.key_display)}</option>)}
          </select></Field>
        </div>
      </>}
      {d.source === 'manual' && <div className="form-grid">
        <Field label="凭据选择"><select value={d.manual} onChange={e => { const manual = e.target.value as Draft['manual']; edit({ manual, ...(manual === 'env' ? { keyStorage: 'user-env' } : {}) }); }}>
          <option value="saved" disabled={!status.config.maskedKey}>沿用已保存密钥{status.config.maskedKey ? ` · ${maskOnly(status.config.maskedKey)}` : '（未配置）'}</option>
          <option value="env" disabled={!status.userEnvHasKey}>使用 ASTRA_API_KEY 环境变量{status.userEnvHasKey ? '' : '（未配置）'}</option><option value="new">输入新的 API 密钥</option>
        </select></Field>
        {d.manual === 'new' && <SecretField key={secretEpoch} label="API 密钥" secret={secret} setSecret={setSecret} />}
      </div>}
      <div className="form-grid subagent-model-fields">
        <Field label="接口协议"><select value={d.protocol} onChange={e => edit({ protocol: e.target.value as Draft['protocol'] })}>{subagentProtocols.map(p => <option value={p} key={p}>{protocols[p][0]} ({protocols[p][1]})</option>)}</select></Field>
        <div className="subagent-endpoint">
          <Field label="接口 Base URL"><input className="mono" type="text" inputMode="url" spellCheck={false} maxLength={4096} value={d.baseUrl} placeholder={localProxyUrl} onChange={e => edit({ baseUrl: e.target.value })} /></Field>
          <div className="subagent-chips" role="group" aria-label="接口地址预设">{endpointPresets(localProxyUrl).map(({ label, baseUrl, protocol }) =>
            <button type="button" key={label} className="subagent-chip" aria-pressed={d.baseUrl.trim() === baseUrl && (!protocol || protocol === d.protocol)}
              onClick={() => edit({ baseUrl, protocol: protocol ?? d.protocol })}>{label}</button>)}</div>
          {endpoint && <small>实际请求：<code>{endpoint}</code></small>}
          {originKey && <div className="subagent-origin-key">
            <SecretField key={secretEpoch} label="新地址 API 密钥" secret={secret} setSecret={setSecret}
              hint={`已切换为其他 API 地址（${origin(d.baseUrl.trim())}），请填写对应的 API 密钥；部署与探测将直接使用此密钥，不会将原地址密钥发往新接口。`} />
            {d.keyStorage === 'user-env' && status.harnesses.some(h => h.installed && !d.targets.includes(h.id)) && <div className="subagent-storage-hint">
              <small>还有已部署的客户端未选中。独立存储可避免更改它们共用的 Windows 环境变量。</small>
              <Btn kind="ghost" icon={KeyRound} onClick={() => edit({ keyStorage: 'mcp-env' })}>改用独立 MCP 密钥存储（mcp-env）</Btn>
            </div>}
          </div>}
        </div>
        <div className="subagent-model-choice"><Field label="默认子代理模型"><input className="mono" value={d.model} maxLength={256} spellCheck={false} placeholder="输入模型标识" onChange={e => edit({ model: e.target.value })} /></Field>
          <div className="subagent-chips" aria-label="推荐模型">{(allModels ? picks : picks.slice(0, 6)).map(m => <button type="button" key={m} className="subagent-chip mono" aria-pressed={d.model === m} onClick={() => edit({ model: m })}>{m}</button>)}
            {picks.length > 6 && <Btn kind="ghost" icon={allModels ? ChevronUp : ChevronDown} aria-expanded={allModels} onClick={() => setAllModels(!allModels)}>{allModels ? '收起' : `更多（${picks.length - 6}）`}</Btn>}
          </div>
        </div>
        <Field label="默认推理强度" hint="非推理模型可选择 none。"><select value={d.reasoningEffort} onChange={e => edit({ reasoningEffort: e.target.value as Draft['reasoningEffort'] })}>{['max','xhigh','high','medium','low','none'].map(v => <option key={v}>{v}</option>)}</select></Field>
        <Field label="默认执行模式"><select value={d.defaultMode} onChange={e => edit({ defaultMode: e.target.value as Draft['defaultMode'] })}><option value="edit">edit · 可读写文件与运行命令</option><option value="readonly">readonly · 只读分析</option></select></Field>
        <div><Field label="上下文上限（词元）" hint="默认会话上限；模型也可按任务自由调整（最高 1M）。"><input type="number" min={MIN_SUBAGENT_CONTEXT_TOKENS} max={MAX_SUBAGENT_CONTEXT_TOKENS} step={1} value={d.context} onChange={e => edit({ context: e.target.value })} /></Field>
          <div className="subagent-chips" aria-label="上下文预设">{[128, 200, 272, 400, 1000].map(k => <button className="subagent-chip" key={k} type="button" aria-pressed={+d.context === k * 1000} onClick={() => edit({ context: String(k * 1000) })}>{k === 1000 ? '1M' : `${k}K`}</button>)}</div>
        </div>
      </div>
      <section className="subagent-compaction" aria-labelledby="compaction-title">
        <h3 id="compaction-title">分块上下文压缩</h3>
        <div className="spread"><div><b>允许模型自主分块压缩</b><small className="subagent-path">ASTRA_ALLOW_MODEL_COMPACTION</small></div><Toggle label="允许模型自主分块压缩" on={d.enableChunkCompaction} change={() => edit({ enableChunkCompaction: !d.enableChunkCompaction })} /></div>
        <small>模型完成阶段性任务或读取大量文件后，可随时调用 <code>compact_context</code> 分块压缩历史，无需等到上下文占满。</small>
        <div className="form-grid">
          <div><Field label="自动兜底触发阈值（%）" hint={triggerTokenHint(d)}><input type="number" min={40} max={95} step={1} value={d.compactTriggerPct} onChange={e => edit({ compactTriggerPct: e.target.value })} /></Field>
            <div className="subagent-chips" aria-label="自动压缩阈值预设">{[60, 75, 88].map(pct => <button className="subagent-chip" key={pct} type="button" aria-pressed={+d.compactTriggerPct === pct} onClick={() => edit({ compactTriggerPct: String(pct) })}>{pct}%</button>)}</div>
          </div>
          <Field label="分块保留最近交互组" hint={`分块压缩时默认保留最近 ${d.compactKeepRecentGroups || 'N'} 组完整对话与工具记录不压缩。`}><input type="number" min={0} max={20} step={1} value={d.compactKeepRecentGroups} onChange={e => edit({ compactKeepRecentGroups: e.target.value })} /></Field>
        </div>
      </section>
      <Disclosure title="高级选项" meta="规则、存储与解释器">
        <div className="subagent-advanced">
          <div className="spread"><div><b>允许单次任务覆写模型</b><small className="subagent-path">ASTRA_ALLOW_MODEL_OVERRIDE</small></div><Toggle label="允许单次任务覆写模型" on={d.allowModelOverride} change={() => edit({ allowModelOverride: !d.allowModelOverride })} /></div>
          <div className="spread"><b>同步写入分工规则 / 系统提示词</b><Toggle label="同步写入分工规则 / 系统提示词" on={d.writeRules} change={() => edit({ writeRules: !d.writeRules })} /></div>
          <Field label="密钥存储方式" hint={d.keyStorage === 'user-env' ? 'Windows 上不向配置文件写入密钥；其他系统将使用客户端 MCP 环境变量。' : '客户端配置将包含密钥，请妥善保管配置和备份。'}><select value={d.keyStorage} onChange={e => { const keyStorage = e.target.value as Draft['keyStorage']; edit({ keyStorage, ...(!originKey && d.source === 'manual' && d.manual === 'env' && keyStorage === 'mcp-env' ? { manual: status.config.maskedKey ? 'saved' : 'new' } : {}) }); }}>
            <option value="user-env">Windows 用户环境变量 ASTRA_API_KEY（推荐）</option><option value="mcp-env">写入各客户端 MCP 环境变量（独立 / 跨平台）</option>
          </select></Field>
          <Field label="自定义 Python 解释器路径"><input className="mono" spellCheck={false} value={d.pythonPath} maxLength={4096} placeholder="留空自动检测" onChange={e => edit({ pythonPath: e.target.value })} /></Field>
          <Field label="补充协作指令（可选）"><textarea rows={3} maxLength={8192} value={d.customInstructions} onChange={e => edit({ customInstructions: e.target.value })} /></Field>
        </div>
      </Disclosure>
    </fieldset>
  </section>;
}
