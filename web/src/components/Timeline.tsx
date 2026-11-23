import { useState } from 'react';
import type { ChannelMonitorTimelinePoint } from '@shared/types';
import { ms, statusName, statusTone, time } from '../lib/display';
export function Timeline({ points }: { points?: ChannelMonitorTimelinePoint[] }) {
  const real = [...(points ?? [])]
    .filter(Boolean)
    .sort((a, b) => String(a.checked_at).localeCompare(String(b.checked_at)))
    .slice(-60);
  const slots: (ChannelMonitorTimelinePoint | null)[] = [
    ...Array<null>(60 - real.length).fill(null),
    ...real,
  ];
  const [hover, setHover] = useState<{ index: number; left: number; top: number } | null>(null);
  const p = hover ? slots[hover.index] : null;
  const select = (index: number, el: Element) => {
    const r = el.getBoundingClientRect();
    setHover({
      index,
      left: Math.max(10, Math.min(innerWidth - 218, r.left - 75)),
      top: r.top > 100 ? r.top - 82 : r.bottom + 7,
    });
  };
  return (
    <div className="timeline-wrap">
      <div
        className="timeline"
        role="slider"
        aria-label="最近 60 次健康检查"
        aria-valuemin={1}
        aria-valuemax={60}
        aria-valuenow={(hover?.index ?? 59) + 1}
        aria-valuetext={
          p
            ? `${time(p.checked_at, true)} ${statusName[p.status]} 对话 ${ms(p.latency_ms)} Ping ${ms(p.ping_latency_ms)}`
            : '无记录'
        }
        tabIndex={0}
        onFocus={(e) => select(59, e.currentTarget.children[59])}
        onBlur={() => setHover(null)}
        onPointerLeave={() => setHover(null)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
            e.preventDefault();
            const i = Math.max(0, Math.min(59, (hover?.index ?? 59) + (e.key === 'ArrowRight' ? 1 : -1)));
            select(i, e.currentTarget.children[i]);
          }
        }}
      >
        {slots.map((v, i) => (
          <i
            aria-hidden="true"
            key={i}
            className={v ? statusTone(v.status) : 'no-record'}
            onPointerEnter={(e) => select(i, e.currentTarget)}
          />
        ))}
      </div>
      <div className="timeline-labels">
        <span>60 次检查</span>
        <span>最近</span>
      </div>
      {hover && (
        <div className="time-tip" role="tooltip" style={{ left: hover.left, top: hover.top }}>
          {p ? (
            <>
              <b>{time(p.checked_at, true)}</b>
              <span className={statusTone(p.status)}>{statusName[p.status]}</span>
              <code>
                对话 {ms(p.latency_ms)} · Ping {ms(p.ping_latency_ms)}
              </code>
            </>
          ) : (
            <span>此节点无记录</span>
          )}
        </div>
      )}
    </div>
  );
}
