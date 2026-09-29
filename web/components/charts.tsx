"use client";

import { useId, useMemo, useState } from "react";

/** Tiny area sparkline; scales to its container width. */
export function Sparkline({ values, color = "var(--accent)", height = 36 }: {
  values: number[]; color?: string; height?: number;
}) {
  const id = useId();
  if (values.length < 2) return <div style={{ height }} />;
  const w = 100;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, height - 2 - ((v - min) / (max - min || 1)) * (height - 6)]);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" className="block w-full" style={{ height }} aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.28" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${line} L${w},${height} L0,${height} Z`} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

type Series = { key: string; label: string; color: string; values: number[] };

/** Multi-series line chart with hover crosshair + tooltip. */
export function LineChart({ labels, series, height = 220, format = (n: number) => String(n) }: {
  labels: string[]; series: Series[]; height?: number; format?: (n: number) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 1000;
  const H = height;
  const padB = 22;
  const padT = 10;
  const max = useMemo(() => Math.max(1, ...series.flatMap((s) => s.values)) * 1.1, [series]);
  const x = (i: number) => (labels.length < 2 ? 0 : (i / (labels.length - 1)) * W);
  const y = (v: number) => padT + (H - padB - padT) * (1 - v / max);
  const ticks = [0, 0.5, 1].map((t) => Math.round(max * t / 1.1));

  return (
    <div className="relative select-none" onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block w-full" style={{ height: H }}
        onMouseMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const i = Math.round(((e.clientX - r.left) / r.width) * (labels.length - 1));
          setHover(Math.max(0, Math.min(labels.length - 1, i)));
        }}>
        {ticks.map((t) => (
          <line key={t} x1="0" x2={W} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        ))}
        {series.map((s) => (
          <path key={s.key} fill="none" stroke={s.color} strokeWidth="2" vectorEffect="non-scaling-stroke"
            strokeLinejoin="round"
            d={s.values.map((v, i) => `${i ? "L" : "M"}${x(i)},${y(v)}`).join(" ")} />
        ))}
        {hover !== null && (
          <line x1={x(hover)} x2={x(hover)} y1={padT} y2={H - padB} stroke="var(--line-strong)" strokeWidth="1"
            vectorEffect="non-scaling-stroke" />
        )}
      </svg>
      {/* y ticks */}
      <div className="pointer-events-none absolute inset-y-0 left-0">
        {ticks.map((t) => (
          <span key={t} className="label absolute left-0 -translate-y-full pb-0.5 text-faint" style={{ top: y(t) }}>{format(t)}</span>
        ))}
      </div>
      {/* x labels: ~6 */}
      <div className="label relative mt-1 h-3 text-faint">
        {labels.map((l, i) => (i % Math.ceil(labels.length / 6) === 0 || i === labels.length - 1) && (
          <span key={i} className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `${(x(i) / W) * 100}%` }}>{l}</span>
        ))}
      </div>
      {hover !== null && (
        <div className="pointer-events-none absolute top-2 z-10 border border-line-strong bg-surface px-3 py-2 text-[13px] shadow-lg"
          style={{ left: `clamp(0px, calc(${(x(hover) / W) * 100}% + 12px), calc(100% - 170px))` }}>
          <div className="label mb-1 text-faint">{labels[hover]}</div>
          {series.map((s) => (
            <div key={s.key} className="flex items-center justify-between gap-5">
              <span className="inline-flex items-center gap-1.5 text-mute"><span className="h-2 w-2" style={{ background: s.color }} />{s.label}</span>
              <b className="tnum font-medium text-ink">{format(s.values[hover])}</b>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Grouped vertical bars with hover values; `highlight` marks one index in accent. */
export function Bars({ data, series, height = 170, highlight, format = (n: number) => String(n) }: {
  data: { label: string; values: Record<string, number> }[];
  series: { key: string; color: string; label: string }[];
  height?: number; highlight?: number; format?: (n: number) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...data.flatMap((d) => series.map((s) => d.values[s.key] ?? 0)));
  return (
    <div>
      <div className="flex items-end gap-2 border-b border-line" style={{ height }}>
        {data.map((d, i) => (
          <div key={d.label} className="relative flex h-full flex-1 items-end justify-center gap-[3px]"
            onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
            {series.map((s) => {
              const v = d.values[s.key] ?? 0;
              const color = highlight === i && series.length === 1 ? "var(--accent)" : s.color;
              return (
                <div key={s.key} className="w-full max-w-[26px] transition-opacity"
                  style={{ height: `${(v / max) * 100}%`, minHeight: v ? 2 : 0, background: color,
                           opacity: hover === null || hover === i ? 1 : 0.45 }} />
              );
            })}
            {hover === i && (
              <div className="pointer-events-none absolute -top-2 left-1/2 z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap border border-line-strong bg-surface px-2 py-1 text-[12px] text-ink">
                {series.map((s) => `${series.length > 1 ? s.label + " " : ""}${format(d.values[s.key] ?? 0)}`).join(" · ")}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex gap-2">
        {data.map((d, i) => (
          <div key={d.label} className={`label flex-1 truncate text-center ${highlight === i ? "text-accent" : "text-faint"}`}>{d.label}</div>
        ))}
      </div>
    </div>
  );
}

export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="flex flex-wrap gap-4 text-[13px] text-mute">
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1.5"><span className="h-2 w-2" style={{ background: i.color }} />{i.label}</span>
      ))}
    </div>
  );
}

/** Filled area chart (reference "Sales YTD" style) with hover readout. */
export function AreaChart({ labels, values, height = 110, format = (n: number) => String(n), tickEvery = 24,
  tickLabel = (l: string, _i: number) => l }: {
  labels: string[]; values: number[]; height?: number; format?: (n: number) => string; tickEvery?: number;
  tickLabel?: (l: string, i: number) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const id = useId();
  const W = 1000, H = height;
  const max = Math.max(1, ...values) * 1.05;
  const x = (i: number) => (values.length < 2 ? 0 : (i / (values.length - 1)) * W);
  const y = (v: number) => H - (v / max) * (H - 4);
  const line = values.map((v, i) => `${i ? "L" : "M"}${x(i)},${y(v)}`).join(" ");
  return (
    <div className="relative select-none" onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block w-full" style={{ height: H }}
        onMouseMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          setHover(Math.max(0, Math.min(values.length - 1, Math.round(((e.clientX - r.left) / r.width) * (values.length - 1)))));
        }}>
        <defs>
          <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="var(--accent)" stopOpacity="0.75" />
            <stop offset="1" stopColor="var(--data)" stopOpacity="0.55" />
          </linearGradient>
        </defs>
        <path d={`${line} L${W},${H} L0,${H} Z`} fill={`url(#${id})`} />
        <path d={line} fill="none" stroke="var(--accent)" strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1="0" y2={H} stroke="rgba(255,255,255,.4)" strokeWidth="1" vectorEffect="non-scaling-stroke" />}
      </svg>
      <div className="relative mt-3 h-4 text-[11.5px] text-mute">
        {labels.map((l, i) => i % tickEvery === 0 && (
          <span key={i} className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `${(x(i) / W) * 100}%` }}>{tickLabel(l, i)}</span>
        ))}
      </div>
      {hover !== null && (
        <div className="pointer-events-none absolute -top-2 z-10 -translate-y-full rounded-md bg-black/90 px-2.5 py-1.5 text-[12px] text-white shadow-lg"
          style={{ left: `clamp(0px, calc(${(x(hover) / W) * 100}% - 60px), calc(100% - 150px))` }}>
          <div className="text-[10.5px] text-mute">{labels[hover]}</div>
          <b className="tnum">{format(values[hover])}</b>
        </div>
      )}
    </div>
  );
}
