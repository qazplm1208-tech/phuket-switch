import { lazy, Suspense } from 'react';
import { Activity, Layers2 } from 'lucide-react';
import { credits, num } from '../lib/display';
import { useStudio } from '../lib/studio';
import { Badge, Empty, Metric, Notice, Section, Skeleton } from './ui';
import LoginGate from './LoginGate';
const TrendChart = lazy(() => import('./Charts').then((m) => ({ default: m.TrendChart })));
export default function AccountOverview() {
  const s = useStudio(),
    a = s.session?.account,
    logged = !!s.session?.authenticated;
  const d = s.usage.data?.dashboard,
    key = s.usage.data?.keyUsage,
    fallback = d?.keyUsageFallback;
  const models = [...(d?.models ?? [])].sort((a, b) => b.actual_cost - a.actual_cost);
  const daily =
    d?.stats?.today_actual_cost ??
    (fallback?.length ? fallback.reduce((n, k) => n + k.today_actual_cost, 0) : null);
  const keyAmount = (n?: number | null) => (n == null ? '—' : `${num(n)} ${key?.unit ?? ''}`);
  return (
    <div className="stack">
      {s.account.error && <Notice retry={s.account.reload}>{s.account.error}</Notice>}
      {s.usage.error && <Notice retry={s.usage.reload}>{s.usage.error}</Notice>}
      {!logged && <LoginGate title="登录 PhuketAI 查看账户与用量" />}
      {s.usage.loading && !s.usage.data && <Skeleton rows={1} />}
      {(logged || key) && (
        <>
          <div className="section-head">
            <h2>{logged ? a?.email || '账户用量' : 'API 密钥用量快照'}</h2>
            {key && <Badge>{key.planName || '/v1/usage'}</Badge>}
          </div>
          <div className="metrics strip">
            <Metric
              label="可用余额"
              value={logged ? credits(a?.balance) : keyAmount(key?.balance ?? key?.remaining)}
            />
            <Metric
              label={logged ? '累计充值' : '累计消耗'}
              value={logged ? credits(a?.total_recharged) : keyAmount(key?.totalActualCost)}
            />
            <Metric label="今日消耗" value={key ? keyAmount(key.todayActualCost) : credits(daily)} />
            <Metric label="今日请求" value={num(d?.stats?.today_requests ?? key?.todayRequests)} />
          </div>
        </>
      )}
      {logged && (
        <div className="chart-duo">
          <div>
            <Section title="近 7 天趋势" />
            {d?.trend.length ? (
              <div className="card padded">
                <div className="inline chart-key">
                  <span>
                    <i className="dot blue" />
                    消耗
                  </span>
                  <span>
                    <i className="dot idle" />
                    请求
                  </span>
                </div>
                <Suspense fallback={<Skeleton />}>
                  <TrendChart points={d.trend} />
                </Suspense>
              </div>
            ) : (
              <Empty icon={Activity} title="暂无趋势数据" />
            )}
          </div>
          <div>
            <Section title="模型消耗" />
            {models.length ? (
              <div className="grouped-list">
                {models.map((m, i) => (
                  <div className="model-cost" key={i}>
                    <div className="spread">
                      <code>{m.model}</code>
                      <b>{credits(m.actual_cost)}</b>
                    </div>
                    <progress max={models[0].actual_cost || 1} value={m.actual_cost} />
                  </div>
                ))}
              </div>
            ) : (
              <Empty icon={Layers2} title="暂无模型明细" />
            )}
          </div>
        </div>
      )}
      {!logged && !key && !s.usage.loading && !s.usage.error && (
        <p className="muted">当前没有可用的 API 密钥用量快照。</p>
      )}
    </div>
  );
}
