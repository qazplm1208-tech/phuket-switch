import { useEffect, useRef, useState } from 'react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Tooltip, XAxis, YAxis } from 'recharts';
import type { PhuketUsageTrendPoint, SpeedCompareSample } from '@shared/types';
const tooltip = {
  background: 'var(--surface)',
  color: 'var(--text)',
  border: '1px solid var(--border)',
  borderRadius: 5,
  fontFamily: 'var(--mono)',
  fontSize: 12,
};
const tick = { fill: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 10 };
const margin = { top: 10, right: 8, bottom: 0, left: 0 };
function useChartWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, set] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => set(Math.floor(el.getBoundingClientRect().width));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}
export function TrendChart({ points }: { points: PhuketUsageTrendPoint[] }) {
  const { ref, width } = useChartWidth();
  return (
    <div className="chart" ref={ref} role="img" aria-label="近七天消耗与请求趋势">
      {width > 0 && (
        <AreaChart width={width} height={160} data={points} margin={margin}>
          <CartesianGrid stroke="var(--border)" strokeDasharray="2 4" vertical={false} />
          <XAxis
            dataKey="date"
            tickFormatter={(v) => String(v).slice(5, 10)}
            tick={tick}
            axisLine={false}
            tickLine={false}
          />
          <YAxis yAxisId="cost" tick={tick} width={36} axisLine={false} tickLine={false} />
          <YAxis yAxisId="requests" hide orientation="right" />
          <Tooltip contentStyle={tooltip} />
          <Area
            yAxisId="cost"
            name="消耗 (credits)"
            type="monotone"
            dataKey="actual_cost"
            stroke="var(--accent)"
            fill="var(--accent)"
            fillOpacity={0.13}
            strokeWidth={2}
            isAnimationActive={false}
          />
          <Area
            yAxisId="requests"
            name="请求数"
            type="monotone"
            dataKey="requests"
            stroke="var(--idle)"
            fill="transparent"
            strokeDasharray="4 3"
            strokeWidth={2}
            isAnimationActive={false}
          />
        </AreaChart>
      )}
    </div>
  );
}
export function LatencyChart({ samples }: { samples: SpeedCompareSample[] }) {
  const { ref, width } = useChartWidth();
  const median = (a: number[]) => {
    a.sort((x, y) => x - y);
    return a.length ? (a[(a.length - 1) >> 1] + a[a.length >> 1]) / 2 : null;
  };
  const series = (key: 'latencyMs' | 'firstTokenMs', mode: 'fast' | 'standard') =>
    median(
      samples
        .filter((s) => s.ok && s.mode === mode)
        .map((s) => s[key])
        .filter((v): v is number => v != null),
    );
  const data = [
    {
      name: '首字延迟',
      standard: series('firstTokenMs', 'standard'),
      fast: series('firstTokenMs', 'fast'),
    },
    {
      name: '总耗时',
      standard: series('latencyMs', 'standard'),
      fast: series('latencyMs', 'fast'),
    },
  ];
  return (
    <div className="chart" ref={ref} role="img" aria-label="标准与 Fast 首 Token 及总耗时中位数对比">
      {width > 0 && (
        <BarChart width={width} height={195} data={data} margin={margin}>
          <CartesianGrid stroke="var(--border)" vertical={false} strokeDasharray="2 4" />
          <XAxis dataKey="name" tick={tick} axisLine={false} tickLine={false} />
          <YAxis tick={tick} width={48} axisLine={false} tickLine={false} />
          <Tooltip contentStyle={tooltip} cursor={{ fill: 'var(--hover)' }} />
          <Bar
            name="标准 (ms)"
            dataKey="standard"
            fill="var(--accent)"
            maxBarSize={38}
            radius={[3, 3, 0, 0]}
            isAnimationActive={false}
          />
          <Bar
            name="Fast (ms)"
            dataKey="fast"
            fill="var(--amber-switch)"
            maxBarSize={38}
            radius={[3, 3, 0, 0]}
            isAnimationActive={false}
          />
        </BarChart>
      )}
    </div>
  );
}
