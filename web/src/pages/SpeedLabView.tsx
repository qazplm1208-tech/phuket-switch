import { lazy, Suspense, useState, type FormEvent } from 'react';
import { ChartNoAxesColumn, Gauge, MessageSquare, Play, Send } from 'lucide-react';
import { allowedGroupModels, sortModelsNewestFirst } from '@shared/constants';
import type { ChatTestResult, LocalProbeResult, PhuketGroup, ProviderView, SpeedCompareResult } from '@shared/types';
import { api } from '../api/client';
import { ms, num, protocolName, time, withFastEnabled } from '../lib/display';
import { messageOf, useResource } from '../lib/resource';
import { useStudio } from '../lib/studio';
import {
  Badge,
  Btn,
  Choices,
  Disclosure,
  Empty,
  Field,
  Metric,
  Notice,
  Section,
  Skeleton,
  Table,
} from '../components/ui';
import ConnectionCheckView from '../components/ConnectionCheckView';
const LatencyChart = lazy(() => import('../components/Charts').then((m) => ({ default: m.LatencyChart })));
const tabs = [
  ['check', '连接检测'],
  ['compare', 'Fast 速度对比'],
  ['chat', '协议对话测试'],
] as const;
function Comparison({ r }: { r: SpeedCompareResult }) {
  return (
    <div className="stack">
      <div className="spread">
        <b>{r.providerName}</b>
        <small>{time(r.finishedAt)}</small>
      </div>
      <div className="metrics channel-metrics">
        <Metric label="标准中位耗时" value={ms(r.standardMedianMs)} />
        <Metric label="Fast 中位耗时" value={ms(r.fastMedianMs)} />
        <Metric label="加速比" value={r.speedup == null ? '—' : `${num(r.speedup)}×`} />
      </div>
      {r.samples.some((v) => v.ok) && (
        <>
          <div className="chart-key">
            <span>
              <i className="dot blue" />
              标准
            </span>
            <span>
              <i className="dot amber" />
              Fast
            </span>
          </div>
          <Suspense fallback={<Skeleton />}>
            <LatencyChart samples={r.samples} />
          </Suspense>
        </>
      )}
      <Disclosure title="请求明细" meta={`${r.samples.length} 次`}>
        <Table heads={['轮次', '实际模型', '首字延迟', '总耗时', '状态']}>
          {r.samples.map((v, i) => (
            <tr key={i}>
              <td>
                {v.run} · {v.mode === 'fast' ? 'Fast' : '标准'}
              </td>
              <td>
                <code>{v.effectiveModel}</code>
                <small>
                  {num(v.tokensPerSec)} tokens/s
                </small>
              </td>
              <td>{ms(v.firstTokenMs)}</td>
              <td>{ms(v.latencyMs)}</td>
              <td>
                <Badge tone={v.ok ? 'good' : 'bad'}>{v.statusCode ?? (v.ok ? '正常' : '异常')}</Badge>
              </td>
            </tr>
          ))}
        </Table>
      </Disclosure>
      {r.samples.some((v) => !v.ok) && (
        <Notice tone="bad">{r.samples.find((v) => !v.ok)?.error || '部分请求失败。'}</Notice>
      )}
    </div>
  );
}
function Runner({ chatMode, providers, groups }: { chatMode: boolean; providers: ProviderView[]; groups: PhuketGroup[] }) {
  const s = useStudio(),
    [id, setId] = useState(providers.find((p) => p.isCurrent)?.id ?? providers[0]?.id);
  const p = providers.find((p) => p.id === id) ?? providers[0];
  const [model, setModel] = useState(p?.model ?? ''),
    [prompt, setPrompt] = useState('用一句话介绍自己。'),
    [runs, setRuns] = useState(1),
    [chatFast, setChatFast] = useState(false);
  const [comparison, setComparison] = useState<SpeedCompareResult | null>(null),
    [reply, setReply] = useState<ChatTestResult | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [probe, setProbe] = useState<LocalProbeResult | null>(null), [probing, setProbing] = useState(false);
  async function probeModels() {
    if (!p || probing || busy) return;
    setProbing(true); setProbe(null); setError('');
    try { setProbe(await api.probeLocal({ providerId: p.id })); }
    catch (e) { setError(messageOf(e)); }
    finally { setProbing(false); }
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!p || !prompt.trim() || busy || probing) return;
    const base = {
      providerId: p.id,
      model: model.trim() || undefined,
      prompt: prompt.trim(),
    };
    setBusy(true);
    setError('');
    setComparison(null);
    setReply(null);
    try {
      if (chatMode)
        setReply(
          await api.chatTest({
            ...base,
            ...(p.protocol === 'openai-responses'
              ? { fastConfig: withFastEnabled(p.codexFastConfig ?? s.fast, chatFast) }
              : {}),
          }),
        );
      else setComparison(await api.speedCompare({ ...base, runs }));
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }
  if (!p)
    return (
      <Empty
        icon={chatMode ? MessageSquare : Gauge}
        title={chatMode ? '暂无可测试的供应商' : '暂无 GPT Responses 供应商'}
        action={<Btn onClick={() => s.navigate('/')}>前往供应商</Btn>}
      />
    );
  return (
    <div className="lab-grid">
      <form className="card padded form-stack" onSubmit={submit}>
        <h2>测试参数</h2>
        <fieldset className="form-stack" disabled={busy || probing}>
          <Field label="供应商">
            <select
              value={p.id}
              onChange={(e) => {
                const v = providers.find((v) => v.id === e.target.value)!;
                setId(v.id);
                setModel(v.model ?? '');
                setChatFast(false);
              }}
            >
              {providers.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={`模型 · ${protocolName(p.protocol)}`}>
            <select className="mono" value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">使用默认模型</option>
              {sortModelsNewestFirst([
                ...(p.availableModels ?? []), ...allowedGroupModels(groups.find(g => g.id === p.phuketGroupId)), p.model ?? '',
              ]).map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </Field>
          <Field label={chatMode ? '消息' : '测试提示词'}>
            <textarea rows={3} required value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          </Field>
          {!chatMode && (
            <label className="inline spread">
              测试轮数
              <select value={runs} onChange={(e) => setRuns(Number(e.target.value))}>
                {[1, 2, 3].map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>
            </label>
          )}
          {chatMode && p.protocol === 'openai-responses' && (
            <label className="check">
              <input type="checkbox" checked={chatFast} onChange={(e) => setChatFast(e.target.checked)} />
              启用 Fast 模式
            </label>
          )}
        </fieldset>
        {probe?.providerId === p.id && <Notice tone={probe.ok ? 'good' : 'bad'}>{probe.ok ? `模型列表可用 · ${ms(probe.latencyMs)}` : `模型列表探测失败 · ${probe.statusCode ?? '连接异常'}`}</Notice>}
        <div className="spread">
          {chatMode ? <Btn icon={Gauge} kind="ghost" disabled={busy} busy={probing} onClick={() => void probeModels()}>探测模型列表</Btn> : <small>共 {runs * 2} 次请求</small>}
          <Btn
            type="submit"
            kind="primary"
            busy={busy}
            icon={chatMode ? Send : Play}
            disabled={!prompt.trim() || probing}
          >
            {chatMode ? '发送' : '开始对比（标准 vs Fast）'}
          </Btn>
        </div>
      </form>
      <section className="card padded lab-result" aria-live="polite">
        <Section title={chatMode ? '对话响应' : '对比结果'} />
        {error ? (
          <Notice tone="bad">{error}</Notice>
        ) : busy ? (
          <div className="stack">
            <small>正在等待供应商响应…</small>
            <Skeleton />
          </div>
        ) : comparison ? (
          <Comparison r={comparison} />
        ) : reply ? (
          <div className="stack">
            <div className="tags">
              <Badge tone={reply.ok ? 'good' : 'bad'}>
                {reply.statusCode ?? (reply.ok ? '正常' : '异常')}
              </Badge>
              <Badge>{reply.effectiveModel}</Badge>
              <Badge>{ms(reply.latencyMs)}</Badge>
              {reply.serviceTier && <Badge>{reply.serviceTier === 'default' ? '标准' : 'Fast'}</Badge>}
            </div>
            <pre className="chat-text">{reply.text || reply.error || '没有文本内容'}</pre>
            <small>
              输入 {num(reply.inputTokens)} · 输出 {num(reply.outputTokens)} tokens
            </small>
          </div>
        ) : (
          <Empty
            icon={chatMode ? MessageSquare : ChartNoAxesColumn}
            title={chatMode ? '暂无对话响应' : '尚未开始测试'}
          />
        )}
      </section>
    </div>
  );
}
export default function SpeedLabView() {
  const s = useStudio(),
    chatMode = s.tab === 'chat', checkMode = !chatMode && s.tab !== 'compare';
  const catalog = useResource(checkMode ? null : 'groups:' + s.identity, api.groups);
  const groups = catalog.data?.groups ?? [];
  return (
    <div className="stack">
      <div className="tab-bar">
        <Choices
          tabs
          label="检测与测速"
          items={tabs}
          value={checkMode ? 'check' : chatMode ? 'chat' : 'compare'}
          change={(v) => s.navigate('/lab', v)}
        />
      </div>
      {checkMode ? <ConnectionCheckView /> : s.providers.error ? (
        <Notice retry={s.providers.reload}>{s.providers.error}</Notice>
      ) : !s.providers.data && s.providers.loading ? (
        <Skeleton />
      ) : (
        <>
          <div hidden={chatMode}>
            <Runner
              groups={groups}
              chatMode={false}
              providers={(s.providers.data ?? []).filter((p) => p.protocol === 'openai-responses')}
            />
          </div>
          <div hidden={!chatMode}>
            <Runner groups={groups} chatMode providers={s.providers.data ?? []} />
          </div>
        </>
      )}
    </div>
  );
}
