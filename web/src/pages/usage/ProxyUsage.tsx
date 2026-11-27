import { ArrowRight, RefreshCw } from 'lucide-react';
import type { ProxyRequestLog } from '@shared/types';
import { api } from '../../api/client';
import { Badge, Btn, Empty, IconBtn, Metric, Notice, Section, Skeleton, Table } from '../../components/ui';
import { appName, ms, num, pct, time } from '../../lib/display';
import { useResource } from '../../lib/resource';
import { useStudio } from '../../lib/studio';

const limit = 1000;
const successful = (l: ProxyRequestLog) => l.statusCode >= 200 && l.statusCode < 300;
const modelOf = (l: ProxyRequestLog) => l.effectiveModel || l.model || '—';
const clientOf = (l: ProxyRequestLog) => l.appType !== 'claude-desktop' && (l.appType === 'claude' || l.translatedFrom === 'anthropic-messages')
  ? 'Claude Code' : appName[l.appType];
const totalOf = (l: ProxyRequestLog) => l.totalTokens ?? (l.inputTokens != null && l.outputTokens != null ? l.inputTokens + l.outputTokens : null);
type Reading = number | undefined | null;
function sum(values: Reading[]) {
  return values.reduce<number | null>((n, v) => v == null ? n : (n ?? 0) + v, null);
}
function mean(values: Reading[]) {
  const reported = values.filter((v): v is number => v != null);
  return reported.length ? reported.reduce((n, v) => n + v, 0) / reported.length : null;
}
function summarize(rows: ProxyRequestLog[]) {
  return {
    successes: rows.filter(successful).length, latency: mean(rows.map(l => l.latencyMs)),
    input: sum(rows.map(l => l.inputTokens)), cached: sum(rows.map(l => l.cachedTokens)),
    output: sum(rows.map(l => l.outputTokens)), total: sum(rows.map(totalOf)),
  };
}
function ProxyReport({ rows }: { rows: ProxyRequestLog[] }) {
  const all = summarize(rows), ttft = mean(rows.map(l => l.ttftMs));
  // Cache reads are a subset of input. Only paired counters belong in either side of the ratio.
  let cacheInput = 0, cacheReads = 0, cacheReports = 0;
  const groups = new Map<string, ProxyRequestLog[]>();
  for (const l of rows) {
    if (l.cachedTokens != null && l.inputTokens != null && l.inputTokens > 0) {
      cacheInput += l.inputTokens; cacheReads += Math.min(l.cachedTokens, l.inputTokens); cacheReports++;
    }
    const id = JSON.stringify([modelOf(l), clientOf(l)]);
    const group = groups.get(id);
    if (group) group.push(l);
    else groups.set(id, [l]);
  }
  const recent = rows.slice(0, 50);
  return (
    <>
      <div className="metrics strip">
        <Metric label="记录请求数" value={num(rows.length)} />
        <Metric label="成功率" value={pct(rows.length ? 100 * all.successes / rows.length : null)} detail={`成功 ${num(all.successes)} 次`} />
        <Metric label="总 Token" value={num(all.total)} detail={`输入 ${num(all.input)} · 输出 ${num(all.output)}`} />
        <Metric label="缓存命中率" value={pct(cacheInput ? 100 * cacheReads / cacheInput : null)} detail={`已上报 ${num(cacheReports)} 次`} />
        <Metric label="平均延迟" value={ms(all.latency)} detail={`平均首字延迟 (TTFT) ${ms(ttft)}`} />
      </div>
      <section className="stack">
        <Section title="按模型与客户端汇总" count={groups.size} />
        {groups.size ? (
          <Table heads={['模型', '客户端', '请求数', '成功数', '输入 Token', '缓存 Token', '输出 Token', '总 Token', '平均耗时']}>
            {[...groups.entries()].sort(([, a], [, b]) => b.length - a.length).map(([id, group]) => {
              const g = summarize(group);
              return <tr key={id}>
                <td><code title={modelOf(group[0])}>{modelOf(group[0])}</code></td><td>{clientOf(group[0])}</td>
                <td>{num(group.length)}</td><td>{num(g.successes)}</td><td>{num(g.input)}</td><td>{num(g.cached)}</td>
                <td>{num(g.output)}</td><td>{num(g.total)}</td><td>{ms(g.latency)}</td>
              </tr>;
            })}
          </Table>
        ) : <Empty title="暂无代理模型用量" />}
      </section>
      <section className="stack">
        <Section title="最近代理请求" count={recent.length} />
        {recent.length ? (
          <Table heads={['时间', '客户端', '模型', '状态码', '输入 Token', '缓存 Token', '输出 Token', '总 Token', '耗时']}>
            {recent.map(l => <tr key={l.id}>
              <td className="mono">{time(l.createdAt, true)}</td><td>{clientOf(l)}</td><td><code title={modelOf(l)}>{modelOf(l)}</code></td>
              <td><Badge tone={successful(l) ? 'good' : 'bad'}>{l.statusCode}</Badge></td>
              <td>{num(l.inputTokens)}</td><td>{num(l.cachedTokens)}</td><td>{num(l.outputTokens)}</td><td>{num(totalOf(l))}</td><td>{ms(l.latencyMs)}</td>
            </tr>)}
          </Table>
        ) : <Empty title="暂无本地代理请求" />}
      </section>
    </>
  );
}

export default function ProxyUsage() {
  const s = useStudio();
  const r = useResource('usage:proxy', signal => api.logs({ limit }, signal));
  return (
    <>
      <Section title="代理用量" actions={<>
        <Btn kind="ghost" icon={ArrowRight} onClick={() => s.navigate('/proxy')}>前往本地代理</Btn>
        <IconBtn label="刷新代理用量" icon={RefreshCw} disabled={r.loading} onClick={r.reload} />
      </>} />
      <p className="footnote">仅统计最近 {num(limit)} 条本地代理日志（共 {num(r.data?.total)} 条）。Token 明细与首字延迟仅含已上报值。</p>
      {r.error && <Notice retry={r.reload}>{r.error}</Notice>}
      {r.loading && !r.data && <Skeleton />}
      {r.data && <ProxyReport rows={r.data.items} />}
    </>
  );
}
