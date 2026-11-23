import { useEffect, useRef, useState } from 'react';
import { Activity, Cable, RefreshCw, ScanLine } from 'lucide-react';
import type { ChannelMonitorItem, LocalProbeResult } from '@shared/types';
import { api } from '../api/client';
import LoginGate from '../components/LoginGate';
import { Timeline } from '../components/Timeline';
import {
  Badge,
  Btn,
  Choices,
  Empty,
  IconBtn,
  Metric,
  Modal,
  Notice,
  Section,
  Skeleton,
  Table,
  Toggle,
} from '../components/ui';
import { ms, pct, protocolName, statusName, statusTone, time } from '../lib/display';
import { useAction, useFeedback } from '../lib/feedback';
import { messageOf, usePoll, useResource } from '../lib/resource';
import { useStudio } from '../lib/studio';

async function pool<T>(items: T[], fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(3, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}
function Detail({ item, close }: { item: ChannelMonitorItem; close: () => void }) {
  const r = useResource(String(item.id), (sig) => api.monitorDetail(item.id, sig));
  return (
    <Modal title={item.name} wide close={close}>
      <div className="stack">
        <div className="inline">
          <Badge>{item.provider}</Badge>
          {item.group_name && <Badge>{item.group_name}</Badge>}
        </div>
        {r.error ? (
          <Notice retry={r.reload}>{r.error}</Notice>
        ) : r.loading ? (
          <Skeleton />
        ) : r.data?.models.length ? (
          <Table heads={['模型', '状态', '延迟', '7 天可用率', '15 天可用率', '30 天可用率', '7 天平均延迟']}>
            {r.data.models.map((m) => (
              <tr key={m.model}>
                <td>
                  <code>{m.model}</code>
                </td>
                <td>
                  <Badge tone={statusTone(m.latest_status)} dot>
                    {statusName[m.latest_status]}
                  </Badge>
                </td>
                <td>{ms(m.latest_latency_ms)}</td>
                <td>{pct(m.availability_7d)}</td>
                <td>{pct(m.availability_15d)}</td>
                <td>{pct(m.availability_30d)}</td>
                <td>{ms(m.avg_latency_7d_ms)}</td>
              </tr>
            ))}
          </Table>
        ) : (
          <Empty title="暂无模型检查记录" />
        )}
      </div>
    </Modal>
  );
}
const periods = [
  ['7', '7 天'],
  ['15', '15 天'],
  ['30', '30 天'],
] as const;
function Channels() {
  const s = useStudio(),
    r = useResource('monitors:' + s.identity, api.monitors);
  const [period, setPeriod] = useState('7'),
    [hide, setHide] = useState(false),
    [left, setLeft] = useState(60),
    [item, setItem] = useState<ChannelMonitorItem | null>(null);
  const deadline = useRef(Date.now() + 60000),
    [revision, bump] = useState(0);
  const refresh = () => {
    r.reload();
    bump((n) => n + 1);
    deadline.current = Date.now() + 60000;
    setLeft(60);
  };
  usePoll(() => {
    const n = Math.max(0, Math.ceil((deadline.current - Date.now()) / 1000));
    if (!n && !r.loading) refresh();
    else setLeft(n);
  }, 1000);
  const channels = (r.data ?? []).filter(
    (m) => !hide || !/gemini/i.test([m.name, m.provider, m.group_name, m.primary_model].join(' ')),
  );
  const detailRates = useResource(
    period !== '7' && channels.length
      ? `${s.identity}:${period}:${revision}:${channels.map((c) => c.id)}`
      : null,
    async (signal) => {
      const values: Record<number, number | null> = {};
      let failed = 0;
      await pool(channels, async (c) => {
        if (signal.aborted) return;
        try {
          const d = await api.monitorDetail(c.id, signal);
          const m = d.models.find((m) => m.model === c.primary_model);
          values[c.id] = (period === '15' ? m?.availability_15d : m?.availability_30d) ?? null;
        } catch {
          failed++;
        }
      });
      return { values, failed };
    },
  );
  const good = channels.every((m) => m.primary_status === 'operational'),
    known = channels.length > 0 && !r.error;
  return (
    <>
      <div className="monitor-bar spread">
        <div className="actions">
          <Choices label="可用率时间范围" items={periods} value={period} change={setPeriod} />
          <Badge tone={!known ? 'muted' : good ? 'good' : 'amber'} dot>
            {!known ? '暂无状态' : good ? '全部正常' : '部分波动'}
          </Badge>
        </div>
        <div className="actions">
          <span>隐藏 Gemini</span>
          <Toggle on={hide} change={() => setHide(!hide)} label="隐藏 Gemini" />
          <span className="countdown mono">{left}s</span>
          <IconBtn label="刷新渠道状态" icon={RefreshCw} onClick={refresh} disabled={r.loading} />
        </div>
      </div>
      {r.error && <Notice retry={refresh}>{r.error}</Notice>}
      {!!detailRates.data?.failed && <Notice retry={detailRates.reload}>部分渠道的可用率暂不可用。</Notice>}
      {r.loading && !r.data ? (
        <Skeleton />
      ) : channels.length ? (
        <div className="channel-grid">
          {channels.map((m) => (
            <article className="card channel" key={m.id} onClick={() => setItem(m)}>
              <div className="spread">
                <h3>
                  <button
                    className="plain"
                    onClick={(e) => {
                      e.stopPropagation();
                      setItem(m);
                    }}
                  >
                    {m.name}
                  </button>
                </h3>
                <Badge tone={statusTone(m.primary_status)} dot>
                  {statusName[m.primary_status]}
                </Badge>
              </div>
              <div className="channel-meta">
                {m.provider}
                <span>·</span>
                <code>{m.primary_model || '未知模型'}</code>
              </div>
              <div className="metrics channel-metrics">
                <Metric
                  label={`${period} 天可用率`}
                  value={pct(period === '7' ? m.availability_7d : detailRates.data?.values[m.id])}
                />
                <Metric label="对话延迟" value={ms(m.primary_latency_ms)} />
                <Metric label="Ping 延迟" value={ms(m.primary_ping_latency_ms)} />
              </div>
              <Timeline points={m.timeline} />
            </article>
          ))}
        </div>
      ) : (
        !r.error && <Empty icon={Activity} title="没有匹配的渠道" />
      )}
      {item && <Detail item={item} close={() => setItem(null)} />}
    </>
  );
}
function LocalProbes() {
  const s = useStudio(),
    { pending, run } = useAction(),
    { notify } = useFeedback();
  const providers = s.providers.data ?? [],
    [results, set] = useState<Record<string, LocalProbeResult>>({});
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function probe() {
    set({});
    let good = 0;
    await pool(providers, async (p) => {
      if (!mounted.current) return;
      let result: LocalProbeResult;
      try {
        result = await api.probeLocal({ providerId: p.id, model: p.model });
      } catch (e) {
        result = {
          providerId: p.id,
          model: p.model ?? '',
          protocol: p.protocol,
          testedAt: new Date().toISOString(),
          ok: false,
          latencyMs: null,
          statusCode: null,
          error: messageOf(e),
        };
      }
      if (result.ok) good++;
      if (mounted.current) set((prev) => ({ ...prev, [p.id]: result }));
    });
    if (mounted.current) notify('本地探活完成', `${good} / ${providers.length} 个端点正常`);
  }
  return (
    <section className="card framed">
      <Section
        title="本地端点探活"
        actions={
          <Btn
            icon={ScanLine}
            busy={!!pending}
            disabled={!providers.length}
            onClick={() => void run('probe', probe)}
          >
            {pending ? `${Object.keys(results).length} / ${providers.length}` : '一键探活'}
          </Btn>
        }
      />
      {s.providers.error ? (
        <Notice retry={s.providers.reload}>{s.providers.error}</Notice>
      ) : s.providers.loading && !s.providers.data ? (
        <Skeleton />
      ) : providers.length ? (
        <Table heads={['供应商', '协议', '状态', '延迟', '检查时间']}>
          {providers.map((p) => {
            const r = results[p.id];
            return (
              <tr key={p.id}>
                <td>
                  <b>{p.name}</b>
                  {r?.error && <small className="bad">{r.error}</small>}
                </td>
                <td>{protocolName(p.protocol)}</td>
                <td>
                  <Badge tone={!r ? 'muted' : r.ok ? 'good' : 'bad'}>
                    {!r ? '未探活' : r.ok ? '正常' : '异常'}
                    {r?.statusCode ? ` · ${r.statusCode}` : ''}
                  </Badge>
                </td>
                <td>{ms(r?.latencyMs)}</td>
                <td>{time(r?.testedAt)}</td>
              </tr>
            );
          })}
        </Table>
      ) : (
        <Empty
          icon={Cable}
          title="暂无本地端点"
          action={<Btn onClick={() => s.navigate('/')}>前往供应商</Btn>}
        />
      )}
    </section>
  );
}
export default function ChannelMonitor() {
  const s = useStudio();
  return (
    <div className="stack">
      <div className="actions"><Btn icon={ScanLine} onClick={() => s.navigate('/lab', 'check')}>连接检测</Btn></div>
      {!s.session && s.auth.loading ? (
        <Skeleton />
      ) : s.session?.authenticated ? (
        <Channels key={s.identity} />
      ) : (
        <LoginGate title="登录 PhuketAI 查看实时渠道状态与 60 节点时间轴" />
      )}
      <LocalProbes />
    </div>
  );
}
