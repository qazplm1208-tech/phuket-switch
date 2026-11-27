import { ArrowRight, RefreshCw } from 'lucide-react';
import type { SubagentUsageResponse } from '@shared/types';
import { api } from '../../api/client';
import { Badge, Btn, Empty, IconBtn, Metric, Notice, Section, Skeleton, Table } from '../../components/ui';
import { num, pct, time } from '../../lib/display';
import { useResource } from '../../lib/resource';
import { useStudio } from '../../lib/studio';
import { protocols } from '../../lib/subagent';

const workerStates = {
  running: ['运行中', 'blue'], completed: ['已完成', 'good'], failed: ['失败', 'bad'], unknown: ['未知', 'muted'],
} as const;

function SubagentReport({ totals, byModel, sessions, workers }: SubagentUsageResponse) {
  return (
    <>
      <div className="metrics strip">
        <Metric label="会话数" value={num(totals.sessionCount)} detail={`总轮次 ${num(totals.turns)}`} />
        <Metric label="累计输入 Token" value={num(totals.inputTokens)} />
        <Metric label="缓存命中率" value={pct(totals.cacheHitRatePct)} detail={`缓存 ${num(totals.cachedTokens)} Token`} />
        <Metric label="累计输出 Token" value={num(totals.outputTokens)} detail={`含推理 ${num(totals.reasoningTokens)} Token`} />
        <Metric label="总 Token" value={num(totals.totalTokens)} />
      </div>
      <section className="stack">
        <Section title="按模型汇总" count={byModel.length} />
        {byModel.length ? (
          <Table heads={['模型', '协议', '会话数', '轮次', '输入 Token', '缓存命中率', '输出 Token', '总 Token']}>
            {byModel.map(m => <tr key={JSON.stringify([m.model, m.protocol])}>
              <td><code title={m.model}>{m.model}</code></td><td>{m.protocol ? protocols[m.protocol][0] : '—'}</td>
              <td>{num(m.sessionCount)}</td><td>{num(m.turns)}</td><td>{num(m.inputTokens)}</td>
              <td>{pct(m.cacheHitRatePct)}<small>缓存 {num(m.cachedTokens)}</small></td>
              <td>{num(m.outputTokens)}<small>含推理 {num(m.reasoningTokens)}</small></td><td>{num(m.totalTokens)}</td>
            </tr>)}
          </Table>
        ) : <Empty title="暂无子代理模型用量" />}
      </section>
      <section className="stack">
        <Section title="会话明细" count={sessions.length} />
        {sessions.length ? (
          <Table heads={['会话 ID', '模型', '工作目录', '模式 / 强度', '轮次', '上下文', '输入 Token', '缓存命中率', '输出 Token', '压缩（全量 / 分块）', '最近更新']}>
            {sessions.map(row => <tr key={row.sessionId}>
              <td><code title={row.sessionId}>{row.sessionId}</code></td><td><code title={row.model}>{row.model}</code></td>
              <td><code title={row.cwd}>{row.cwd || '—'}</code></td><td>{row.mode ?? '—'} / {row.reasoningEffort ?? '—'}</td><td>{num(row.turns)}</td>
              <td>{num(row.lastInputTokens)} / {num(row.maxContextTokens)}<small>{pct(row.maxContextTokens > 0 ? 100 * row.lastInputTokens / row.maxContextTokens : null)}</small></td>
              <td>{num(row.inputTokens)}</td><td>{pct(row.cacheHitRatePct)}</td><td>{num(row.outputTokens)}</td>
              <td>{num(row.compactions)} / {num(row.chunkCompactions)}</td><td className="mono">{time(row.updatedAt, true)}</td>
            </tr>)}
          </Table>
        ) : <Empty title="暂无子代理会话" />}
      </section>
      <section className="stack">
        <Section title="最近后台 Worker" count={workers.length} />
        <p className="footnote">Worker 仅展示后台任务记录，用量已计入所属会话，不重复累加。</p>
        {workers.length ? (
          <Table heads={['Worker 名称', '状态', '模型', '步数', '耗时', '本轮 Token', '缓存命中率', '开始时间']}>
            {workers.map(w => <tr key={w.workerId}>
              <td><code title={w.workerId}>{w.workerName || w.workerId}</code></td>
              <td title={w.status}><Badge dot tone={workerStates[w.status][1]}>{workerStates[w.status][0]}</Badge></td>
              <td><code title={w.model}>{w.model}</code></td><td>{num(w.stepsUsed)}</td>
              <td>{w.elapsedSeconds == null ? '—' : `${num(w.elapsedSeconds)} s`}</td>
              <td>{num(w.usage?.totalTokens)}</td><td>{pct(w.usage?.cacheHitRatePct)}</td><td className="mono">{time(w.startedAt, true)}</td>
            </tr>)}
          </Table>
        ) : <Empty title="暂无后台 Worker" />}
      </section>
    </>
  );
}

export default function SubagentUsage() {
  const s = useStudio(), r = useResource('usage:subagent', api.subagentUsage);
  return (
    <>
      <Section title="会话用量" actions={<>
        <Btn kind="ghost" icon={ArrowRight} onClick={() => s.navigate('/subagent')}>前往子代理配置</Btn>
        <IconBtn label="刷新子代理用量" icon={RefreshCw} disabled={r.loading} onClick={r.reload} />
      </>} />
      {r.error && <Notice retry={r.reload}>{r.error}</Notice>}
      {r.loading && !r.data && <Skeleton />}
      {r.data && <SubagentReport {...r.data} />}
    </>
  );
}
