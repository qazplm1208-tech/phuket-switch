import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Copy, Download, KeyRound, Play, RefreshCw, Wallet } from 'lucide-react';
import { DEFAULT_PROXY_PORT, pickRecommendedModel, workbenchGroup } from '@shared/constants';
import type { ConnectionCheckResult, ConnectionCheckTarget, PhuketApiKeyView } from '@shared/types';
import { api } from '../api/client';
import { credits, ms } from '../lib/display';
import { copyText, useAction, useFeedback } from '../lib/feedback';
import { messageOf, useResource } from '../lib/resource';
import { useStudio } from '../lib/studio';
import LoginGate from './LoginGate';
import { Badge, Btn, Choices, Disclosure, Empty, Field, Notice, Skeleton } from './ui';

async function eligibleKeys(signal: AbortSignal) {
  const [{ groups }, first] = await Promise.all([api.groups(signal), api.keys({ page: 1, pageSize: 100 }, signal)]);
  const keys = new Map<number, PhuketApiKeyView>();
  let batch = first;
  while (true) {
    const before = keys.size;
    for (const item of batch.items) keys.set(item.id, item);
    if (keys.size >= batch.total || keys.size === before) break;
    batch = await api.keys({ page: batch.page + 1, pageSize: 100 }, signal);
  }
  return [...keys.values()].flatMap(key => {
    const group = workbenchGroup(key, groups);
    return group ? [{ id: key.id, name: key.name, group }] : [];
  }).sort((a, b) => Number(b.group.platform === 'openai') - Number(a.group.platform === 'openai'));
}
function Guidance({ result, busy, recreate, retest }: { result: ConnectionCheckResult; busy: boolean; recreate: () => void; retest: () => void }) {
  const { navigate } = useStudio(), g = result.guidance;
  if (!g) return null;
  const balance = g.balanceCheck;
  return <aside className="diagnostic-guidance">
    <strong>{g.title}</strong>
    {balance && <div><Badge tone={balance.sufficient ? 'good' : 'amber'}>{balance.sufficient ? '余额正常' : '账户余额'} · {balance.accountBalance === null ? '未能核实' : credits(balance.accountBalance)}</Badge><small>{balance.summary}</small></div>}
    <ol>{g.steps.map(step => <li key={step}>{step}</li>)}</ol>
    <div className="actions">
      {g.action === 'recharge' && <Btn icon={Wallet} kind="primary" onClick={() => navigate('/groups', 'recharge')}>前往余额充值</Btn>}
      {g.action === 'create_key_and_retest' && <Btn icon={KeyRound} kind="primary" disabled={busy || result.groupId == null} onClick={recreate}>一键新建 API 密钥并重新测试</Btn>}
      {g.action === 'check_network' && <Btn icon={RefreshCw} disabled={busy} onClick={retest}>重新检测</Btn>}
    </div>
  </aside>;
}
function NewKeyBanner({ issued, model, dismiss }: { issued: Awaited<ReturnType<typeof api.createKey>>; model: string; dismiss: () => void }) {
  const s = useStudio(), { notify } = useFeedback(), { pending, run } = useAction();
  return <aside className="diagnostic-issued stack"><strong>新密钥已创建 · {issued.item.name}</strong>
    <small>离开或关闭后不再显示复制入口。原密钥未更改。</small>
    <div className="actions"><Btn icon={Copy} onClick={() => copyText(issued.key, notify)}>复制新密钥</Btn>
      <Btn icon={Download} busy={!!pending} onClick={() => run('import', async () => {
        await api.importKey(issued.item.id, { appType: 'codex', model }); s.refreshProviders(); notify('已导入本地供应商'); dismiss();
      })}>导入本地供应商</Btn><Btn kind="ghost" disabled={!!pending} onClick={dismiss}>关闭</Btn>
    </div></aside>;
}
function Step({ stage, result, busy, children }: { stage: 'online' | 'local'; result: ConnectionCheckResult | null; busy: boolean; children?: ReactNode }) {
  const { notify } = useFeedback(), online = stage === 'online', step = result?.[stage], error = step?.error;
  const status = step?.status, label = status === 'skipped' ? '已跳过（步骤 1 在线检测未通过）' : status === 'passed' ? '通过' : status === 'failed' ? '失败' : busy ? online ? '检测中…' : '等待检测结果' : '未开始';
  return <section className="card padded stack diagnostic-step">
    <div className="spread"><h3>{online ? '步骤 1 · 工作台在线连接（聊天室）' : '步骤 2 · 本地连接检测'}</h3>
      <Badge dot tone={status === 'passed' ? 'good' : status === 'failed' ? 'bad' : 'muted'}>{label}</Badge></div>
    {step && status !== 'skipped' && <small>耗时 {ms(step.latencyMs)} · 首字延迟 {ms(step.firstTokenMs)}</small>}
    {step?.previewText && <pre className="chat-text">{step.previewText}</pre>}
    {error && result && <>
      <strong>{online ? '在线连接失败' : '本地连接失败'}</strong>
      <code className="diagnostic-code">错误码：{error.code}</code>
      {children}
      {online ? <p>{error.message}</p> : <>
        <table className="diagnostic-details"><tbody>{[
          ['错误码', error.code], ['HTTP 状态', error.httpStatus ?? '无'], ['网络/上游错误', [error.networkCode, error.upstreamCode, error.upstreamType].filter(Boolean).join(' · ') || '无'],
          ['检测地址', step.endpoint], ['详细信息', error.message],
        ].map(([key, value]) => <tr key={key}><th scope="row">{key}</th><td>{value}</td></tr>)}</tbody></table>
        <Field label="诊断报告"><textarea readOnly rows={6} className="mono" value={result.diagnosticReport} /></Field>
      </>}
      <div className="actions">{!online && <Btn icon={Copy} onClick={() => copyText(error.code, notify)}>复制错误码</Btn>}
        <Btn icon={Copy} onClick={() => copyText(result.diagnosticReport, notify)}>复制完整诊断报告</Btn></div>
    </>}
  </section>;
}
function Check() {
  const s = useStudio(), keys = useResource('check-keys:' + s.identity, eligibleKeys);
  const [selection, setSelection] = useState(0), [slug, setSlug] = useState(''), [target, setTarget] = useState<ConnectionCheckTarget>('direct');
  const [result, setResult] = useState<ConnectionCheckResult | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [issued, setIssued] = useState<{ response: Awaited<ReturnType<typeof api.createKey>>; model: string } | null>(null);
  const [newOption, setNewOption] = useState<Awaited<ReturnType<typeof eligibleKeys>>[number] | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const listed = keys.data ?? [];
  const keyOptions = newOption && !listed.some(k => k.id === newOption.id) ? [newOption, ...listed] : listed;
  const key = keyOptions.find(k => k.id === selection) ?? keyOptions[0];
  const models = useResource(key ? `${s.identity}:${key.id}` : null, signal => api.workbenchModels(key!.id, signal));
  const options = models.data ?? [], model = options.some(o => o.id === slug) ? slug : pickRecommendedModel(options.map(o => o.id), 'openai-responses');
  function clear() { setResult(null); setError(''); }
  async function start() {
    if (busy || !key || !model) return;
    clear(); setBusy(true);
    try { setResult(await api.connectionCheck({ keyId: key.id, model, localTarget: target })); }
    catch (e) { setError(messageOf(e)); } finally { setBusy(false); }
  }
  async function recreate() {
    if (busy || !key || result?.guidance?.action !== 'create_key_and_retest' || result.groupId == null) return;
    setBusy(true); setError('');
    try {
      const name = `conn-check-${Date.now()}`;
      const response = await api.createKey({ name, group_id: result.groupId });
      if (!mounted.current) return;
      const id = response.item.id;
      setIssued({ response, model: result.model });
      setNewOption({ id, name: response.item.name || name, group: key.group });
      setSelection(id); setSlug(result.model); setResult(null); keys.reload();
      setResult(await api.connectionCheck({ keyId: id, model: result.model, localTarget: result.local.target }));
    } catch (e) { setError(messageOf(e)); } finally { setBusy(false); }
  }
  const guidance = result && <Guidance result={result} busy={busy} recreate={recreate} retest={start} />;
  if (keys.error && !key) return <Notice retry={keys.reload}>{keys.error}</Notice>;
  if (keys.loading && !key) return <Skeleton />;
  if (!key) return <Empty title="暂无启用的 OpenAI 接口密钥" action={<Btn onClick={() => s.navigate('/groups', 'keys')}>前往分组与密钥</Btn>} />;
  return <div className="stack">
    <p className="diagnostic-tip">仅支持测试 OpenAI 接口的模型。先在工作台聊天室测试，在线通过后再检测本地连接。</p>
    <div className="lab-grid"><section className="card padded form-stack"><h2>检测参数</h2>
      <fieldset className="form-stack" disabled={busy}>
        <Field label="检测密钥（仅 OpenAI 接口）"><select value={key.id} onChange={e => { clear(); setSlug(''); setSelection(Number(e.target.value)); }}>
          {keyOptions.map(k => <option key={k.id} value={k.id}>{k.name} · {k.group.name}</option>)}
        </select></Field>
        <Field label="测试模型"><select value={model ?? ''} disabled={!options.length} onChange={e => { clear(); setSlug(e.target.value); }}>
          {!options.length && <option value="">{models.loading ? '正在获取模型…' : '暂无可用的聊天模型'}</option>}
          {options.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select></Field>
        {models.error && <Notice retry={models.reload}>{models.error}</Notice>}
        <div className="field"><span>本地检测方式</span><Choices label="本地检测方式" value={target} change={v => { clear(); setTarget(v); }} items={[
          ['direct', '本机直连 API'], ['proxy', `本地代理 (:${s.proxy?.settings.port ?? DEFAULT_PROXY_PORT})`],
        ] as const} /></div>
      </fieldset>
      <Btn busy={busy} disabled={!model || models.loading || !!models.error} kind="primary" icon={Play} onClick={start}>开始连接检测</Btn>
      {keys.error && <Notice retry={keys.reload}>{keys.error}</Notice>}
      {error && <Notice tone="bad">{error}</Notice>}
      {issued && <NewKeyBanner key={issued.response.item.id} issued={issued.response} model={issued.model} dismiss={() => setIssued(null)} />}
    </section><div className="stack" aria-live="polite">
      <Step stage="online" result={result} busy={busy}>{guidance}</Step><Step stage="local" result={result} busy={busy}>{guidance}</Step>
      {result?.overallStatus === 'passed' && <div className="diagnostic-success">在线通道正常 ({ms(result.online.latencyMs)}) · 本地连接正常 ({ms(result.local.latencyMs)})</div>}
    </div></div>
  </div>;
}
export default function ConnectionCheckView() {
  const s = useStudio();
  if (!s.session && s.auth.loading) return <Skeleton />;
  return <div className="stack">
    {s.session?.authenticated ? <Check key={s.identity} /> : <LoginGate title="登录 PhuketAI 以使用工作台在线 + 本地两阶段连接检测" />}
    <Disclosure title="常见错误码排查指南"><ul className="diagnostic-guide">
      <li><b>403：</b>先检查账户余额和密钥额度；两者正常时，新建同分组 API 密钥再测。</li>
      <li><b>429：</b>新开对话。在 Codex 复制当前会话的深度链接并发给新对话，以保留聊天记录。</li>
      <li><b>502 / 503：</b>在线通过但本地失败时，先检查本机网络和系统代理，再重新检测。</li>
      <li><b>在线失败：</b>按提示排查后仍不通过，请复制完整诊断报告反馈管理员。</li>
    </ul></Disclosure>
  </div>;
}
