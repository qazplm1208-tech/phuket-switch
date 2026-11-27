import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { PhuketModelUsage, PhuketUsageLog } from '@shared/types';
import { api } from '../../api/client';
import { UsageTrend } from '../../components/AccountOverview';
import LoginGate from '../../components/LoginGate';
import { Choices, Empty, IconBtn, Metric, Notice, Section, Skeleton, Table } from '../../components/ui';
import { credits, ms, num, pct, recentDays, time } from '../../lib/display';
import { useResource } from '../../lib/resource';
import { useStudio } from '../../lib/studio';

const windows = [['1d', '今天'], ['7d', '近 7 天'], ['30d', '近 30 天']] as const;
type WindowId = (typeof windows)[number][0];

function ModelCosts({ models }: { models: PhuketModelUsage[] }) {
  const rows = [...models].sort((a, b) => b.actual_cost - a.actual_cost);
  const totalCost = rows.reduce((sum, m) => sum + (m.actual_cost ?? 0), 0);
  return (
    <section className="stack">
      <Section title="模型消耗" count={rows.length} />
      {rows.length ? (
        <Table heads={['模型', '请求数', '输入 Token', '输出 Token', '缓存读取', '缓存写入', '实际费用']}>
          {rows.map(m => (
            <tr key={m.model}>
              <td><code>{m.model}</code></td><td>{num(m.requests)}</td>
              <td>{num(m.input_tokens)}</td><td>{num(m.output_tokens)}</td>
              <td>{num(m.cache_read_tokens)}</td><td>{num(m.cache_creation_tokens)}</td>
              <td>{credits(m.actual_cost)}
                {m.actual_cost != null && <progress aria-label={`${m.model} 费用占比`} max={totalCost || 1} value={m.actual_cost} />}
              </td>
            </tr>
          ))}
        </Table>
      ) : <Empty title="暂无模型明细" />}
    </section>
  );
}

function RecentCalls({ logs, keyNames }: { logs: PhuketUsageLog[]; keyNames: Map<number, string> }) {
  return (
    <section className="stack">
      <Section title="近期调用明细" count={logs.length} />
      {logs.length ? (
        <Table heads={['时间', '模型', '密钥', '输入 Token', '输出 Token', '耗时', '费用']}>
          {logs.map(log => (
            <tr key={log.id}>
              <td className="mono">{time(log.created_at, true)}</td><td><code>{log.model}</code></td>
              <td>{keyNames.get(log.api_key_id) || `#${log.api_key_id}`}</td>
              <td>{num(log.input_tokens)}</td><td>{num(log.output_tokens)}</td>
              <td>{ms(log.duration_ms)}</td><td>{credits(log.actual_cost)}</td>
            </tr>
          ))}
        </Table>
      ) : <Empty title="此时段暂无调用记录" />}
    </section>
  );
}

export default function PhuketUsage() {
  const s = useStudio(), logged = !!s.session?.authenticated;
  const [period, setPeriod] = useState<WindowId>('7d');
  const r = useResource(`phuket-usage:${s.identity}:${period}`, signal => api.usage(recentDays(parseInt(period, 10)), signal));
  const keys = useResource(logged ? `usage-keys:${s.identity}` : null, signal => api.keys({ page: 1, pageSize: 100 }, signal));
  const keyNames = new Map(keys.data?.items.filter(k => k.status === 'active').map(k => [k.id, k.name]));
  const d = r.data?.dashboard, stats = d?.stats, key = r.data?.keyUsage, account = s.session?.account;
  const fallback = d?.keyUsageFallback;
  const cost = (field: 'today_actual_cost' | 'total_actual_cost') =>
    credits(stats?.[field] ?? (fallback?.length ? fallback.reduce((sum, k) => sum + k[field], 0) : null));
  const keyAmount = (v?: number | null) => v == null ? '—' : `${num(v)} ${key?.unit ?? ''}`;
  const input = stats?.total_input_tokens, cached = stats?.total_cache_read_tokens;
  function refresh() {
    r.reload();
    s.account.reload();
    s.usage.reload();
    if (logged) keys.reload();
  }
  return (
    <>
      <Section title={key ? 'API 密钥用量快照' : '账户概览'} actions={<>
        {logged && <Choices label="统计时段" items={windows} value={period} change={setPeriod} />}
        <IconBtn label="刷新账户用量" icon={RefreshCw} disabled={r.loading} onClick={refresh} />
      </>} />
      {s.account.error && <Notice retry={s.account.reload}>{s.account.error}</Notice>}
      {r.error && <Notice retry={refresh}>{r.error}</Notice>}
      {r.loading && !r.data && <Skeleton />}
      {!logged && !key && !r.loading && <LoginGate title="登录 PhuketAI 查看账户与调用明细" />}
      {r.data && (logged || key) && (
        <div className="metrics strip">
          <Metric label="可用余额" value={key ? keyAmount(key.balance ?? key.remaining) : credits(account?.balance)} />
          <Metric label="今日消耗" value={key ? keyAmount(key.todayActualCost) : cost('today_actual_cost')} />
          <Metric label="累计消耗" value={key ? keyAmount(key.totalActualCost) : cost('total_actual_cost')}
            detail={logged ? `累计充值 ${credits(account?.total_recharged)}` : undefined} />
          <Metric label="今日请求" value={num(stats?.today_requests ?? key?.todayRequests)} detail={`总请求 ${num(stats?.total_requests ?? key?.totalRequests)}`} />
          <Metric label="今日 Token" value={num(stats?.today_tokens ?? key?.todayTokens)} detail={`累计 Token ${num(stats?.total_tokens ?? key?.totalTokens)}`} />
          <Metric label="缓存读取" value={num(cached)} detail={input != null && cached != null && input + cached > 0 ? `占输入 ${pct(100 * cached / (input + cached))}` : undefined} />
        </div>
      )}
      {logged && d && <>
        <UsageTrend points={d.trend} period={windows.find(([id]) => id === period)![1]} />
        <ModelCosts models={d.models} />
        {keys.error && <Notice retry={keys.reload}>未能读取密钥名称，调用明细将显示密钥 ID。</Notice>}
        <RecentCalls logs={d.recentLogs} keyNames={keyNames} />
      </>}
    </>
  );
}
