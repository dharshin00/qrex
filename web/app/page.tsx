"use client";

import Link from "next/link";
import { useState } from "react";
import { useLive } from "@/lib/api";
import { usePlatformFilter } from "@/lib/filter";
import { Icon, type IconName } from "@/components/icons";
import { ErrorNote, PLATFORM_VAR, platformLabel } from "@/components/ui";

type Kpi = { key: string; label: string; value: number; series: number[]; change_pct: number | null };
type Summary = {
  days: string[];
  kpis: Kpi[];
  heatmap: { platform: string; store_id: string; city: string; values: number[] }[];
  by_platform: { platform: string; revenue: number; share: number }[];
  by_city: { city: string; revenue: number; share: number }[];
  top_skus: { canonical_sku: string; product_name: string; revenue: number; units: number; share: number }[];
};
type Ov = { connectors: { platform: string; display_name: string; status: string }[] };

const KPI_ICON: Record<string, IconName> = { revenue: "money", orders: "doc", units: "sku", aov: "cart" };

// ---------------------------------------------------------------------------
// formatting (₹ with Indian short scales)
// ---------------------------------------------------------------------------
const money = (n: number) =>
  n >= 1e7 ? `₹${(n / 1e7).toFixed(2)}Cr` : n >= 1e5 ? `₹${(n / 1e5).toFixed(1)}L` : n >= 1e3 ? `₹${(n / 1e3).toFixed(1)}K` : `₹${Math.round(n)}`;
const count = (n: number) => (n >= 1e5 ? `${(n / 1e5).toFixed(1)}L` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : `${Math.round(n)}`);
const fmtKpi = (k: string, n: number) => (k === "revenue" ? money(n) : k === "aov" ? `₹${Math.round(n).toLocaleString("en-IN")}` : count(n));
const dayLabel = (iso: string, style: "short" | "narrow" = "short") =>
  new Date(iso + "T00:00:00").toLocaleDateString(undefined, { weekday: style });

function Delta({ pct, suffix = "", size = 11 }: { pct: number | null; suffix?: string; size?: number }) {
  if (pct == null) return <span className="text-faint" style={{ fontSize: size }}>—</span>;
  const up = pct >= 0;
  return (
    <span className="inline-flex items-center gap-0.5 font-medium tnum" style={{ color: up ? "var(--good)" : "var(--bad)", fontSize: size }}>
      {up ? "▲" : "▼"} {Math.abs(pct).toFixed(1)}%{suffix}
    </span>
  );
}

export default function SummaryPage() {
  const [platform] = usePlatformFilter();
  const { data, error } = useLive<Summary>(`/metrics/summary${platform ? `?platform=${platform}` : ""}`);
  const { data: ov } = useLive<Ov>("/metrics/overview");
  const [metric, setMetric] = useState("revenue");

  const paused = ov?.connectors.filter((c) => c.status === "paused") ?? [];
  const selected = data?.kpis.find((k) => k.key === metric) ?? data?.kpis[0];

  return (
    <div>
      <div className="mb-14 min-h-[120px] md:mb-[72px]">
        <h1 className="text-[34px] font-semibold leading-tight tracking-[-0.01em] text-white md:text-[42px]">Quick-Commerce Sales Dashboard</h1>
        <p className="mt-2 text-[14px] text-white/70">
          Last 7 days across {platform ? platformLabel(platform) : "Blinkit & Swiggy Instamart"} · retrieved through consented source paths
        </p>
      </div>

      {paused.map((c) => (
        <div key={c.platform} className="rise mb-3 flex flex-wrap items-center gap-3 rounded-lg bg-pink/15 px-4 py-3 text-[13px] text-white ring-1 ring-pink/40">
          <Icon name="key" className="text-pink" />
          <span className="flex-1"><b>{c.display_name}</b> session expired — sync paused, figures below are the last good data.</span>
          <Link href={`/connectors/${c.platform}/reauth`} className="rounded-md bg-pink px-3 py-1.5 font-semibold">Re-authenticate</Link>
        </div>
      ))}
      <ErrorNote error={error} />

      {/* KPI cards */}
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        {(data?.kpis ?? Array.from({ length: 4 }, () => null)).map((k, i) =>
          k ? <KpiCard key={k.key} k={k} days={data!.days} active={metric === k.key} onSelect={() => setMetric(k.key)} />
            : <div key={i} className="skeleton h-[125px]" />)}
      </div>

      {/* chart grid */}
      {!data ? (
        <div className="mt-2.5 grid gap-2.5 lg:grid-cols-3">{[0, 1, 2].map((i) => <div key={i} className="skeleton h-[520px]" />)}</div>
      ) : (
        <div className="mt-2.5 grid gap-2.5 lg:grid-cols-3 lg:grid-rows-[auto_auto]">
          <Panel title="Revenue by store in the last 7 days" legend={<HeatLegend />}>
            <StoreHeatmap rows={data.heatmap} days={data.days} />
          </Panel>

          <section className="bg-surface lg:row-span-2">
            <Panel title="Revenue by platform · 7d" flat>
              <VBars height={170} ref_label="avg"
                items={data.by_platform.map((p) => ({
                  label: platformLabel(p.platform), value: p.revenue, text: money(p.revenue),
                  note: <span className="text-faint">{p.share}% share</span>, color: "var(--data)",
                  dot: PLATFORM_VAR[p.platform],
                }))} />
            </Panel>
            <div className="mx-6 h-px bg-black/50" />
            <Panel title={`${selected?.label ?? "Revenue"} per day`} flat
              legend={<span className="text-[11px] text-faint">▲ vs previous day · today so far</span>}>
              {selected && (
                <VBars height={170} ref_label="avg" highlightLast
                  items={selected.series.map((v, i) => ({
                    label: i === selected.series.length - 1 ? "Today" : dayLabel(data.days[i]),
                    value: v, text: fmtKpi(selected.key, v),
                    note: i ? <Delta pct={selected.series[i - 1] ? ((v - selected.series[i - 1]) / selected.series[i - 1]) * 100 : null} size={10} /> : null,
                    color: i === selected.series.length - 1 ? "var(--data-soft)" : "var(--data)",
                  }))} />
              )}
            </Panel>
          </section>

          <Panel title="Busiest dark stores · 7d">
            <BusiestStores rows={data.heatmap} />
          </Panel>

          <Panel title="Revenue by city · 7d">
            <CityMap cities={data.by_city} />
          </Panel>

          <Panel title="Top 5 SKUs by revenue · 7d">
            <HBars items={data.top_skus.map((s) => ({ label: s.product_name, value: s.revenue, text: money(s.revenue), share: s.share }))} />
          </Panel>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// building blocks
// ---------------------------------------------------------------------------
function Panel({ title, legend, children, flat }: { title: string; legend?: React.ReactNode; children: React.ReactNode; flat?: boolean }) {
  return (
    <section className={`min-w-0 px-5 pb-5 pt-5 ${flat ? "" : "bg-surface"}`}>
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-[14px] font-semibold text-white">{title}</h2>
        {legend}
      </div>
      {children}
    </section>
  );
}

function KpiCard({ k, days, active, onSelect }: { k: Kpi; days: string[]; active: boolean; onSelect: () => void }) {
  const max = Math.max(...k.series, 1);
  return (
    <button onClick={onSelect} aria-pressed={active}
      className={`group relative flex h-[125px] min-w-0 items-stretch gap-3 bg-surface px-5 py-4 text-left transition hover:bg-[#383838] ${active ? "ring-1 ring-inset ring-accent/40" : ""}`}>
      <div className="flex min-w-0 flex-1 flex-col justify-between">
        <div className={`flex items-center gap-2 text-[13px] ${active ? "text-accent" : "text-mute"}`}>
          <Icon name={KPI_ICON[k.key] ?? "chart"} size={18} strokeWidth={1.8} />
          {k.label}
        </div>
        <div className="truncate text-[28px] font-bold leading-none text-white tnum">{fmtKpi(k.key, k.value)}</div>
        <div className="flex items-center gap-1.5"><Delta pct={k.change_pct} size={11.5} /><span className="text-[11px] text-faint">day on day</span></div>
      </div>
      <div className="flex w-[46%] items-end gap-[3px] pb-1 pt-7" title={`${k.label} per day, last 7 days`}>
        {k.series.map((v, i) => (
          <div key={i} className="flex-1 transition-colors" title={`${dayLabel(days[i])}: ${fmtKpi(k.key, v)}`}
            style={{ height: `${Math.max(4, (v / max) * 100)}%`,
                     background: active ? (i === k.series.length - 1 ? "#5d61c9" : "var(--accent)") : "#555558" }} />
        ))}
      </div>
      <span className={`absolute right-3 top-3 grid h-3.5 w-3.5 place-items-center rounded-full border ${active ? "border-accent" : "border-white/35"}`}>
        {active && <span className="h-1.5 w-1.5 rounded-full bg-accent" />}
      </span>
    </button>
  );
}

function heat(v: number, min: number, max: number) {
  const t = max > min ? (v - min) / (max - min) : 0.5;
  return `color-mix(in srgb, var(--accent) ${Math.round(t * 100)}%, #8a8a90)`;
}

function HeatLegend() {
  return (
    <div className="flex items-center gap-1.5 text-[10px] text-mute">
      <span className="bg-[#5a5a5e] px-1.5 py-0.5">Low</span>
      <span className="h-px w-5 bg-white/30" />
      <span className="bg-data px-1.5 py-0.5 text-white">High</span>
    </div>
  );
}

function StoreHeatmap({ rows, days }: { rows: Summary["heatmap"]; days: string[] }) {
  const full = rows.flatMap((r) => r.values.slice(0, -1)); // today is partial; scale on full days
  const min = Math.min(...full), max = Math.max(...full);
  const top = Math.max(...full);
  return (
    <div className="overflow-x-auto">
      <table className="mx-auto border-separate border-spacing-[3px] text-[11px]">
        <thead>
          <tr>
            <th />
            {days.map((d, i) => <th key={d} className="px-0.5 pb-1 font-normal text-mute">{i === days.length - 1 ? "Today" : dayLabel(d)}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.platform + r.store_id}>
              <td className="whitespace-nowrap pr-2 text-right text-mute">
                {r.city}
                <span className="ml-1.5 inline-block w-[22px] text-left text-[9px] font-semibold" style={{ color: PLATFORM_VAR[r.platform] }}>
                  {r.platform === "blinkit" ? "BLK" : "IM"}
                </span>
              </td>
              {r.values.map((v, i) => {
                const isToday = i === r.values.length - 1;
                return (
                  <td key={i} title={`${r.store_id} · ${isToday ? "today so far" : dayLabel(days[i])}: ${money(v)}`}
                    className="h-[22px] w-[30px] rounded-[4px] text-center text-[8.5px] font-medium text-white/90"
                    style={{ background: isToday ? "#4a4a4e" : heat(v, min, max), outline: v === top ? "1px solid rgba(255,255,255,.6)" : undefined }}>
                    {v === top ? money(v).replace("₹", "") : ""}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type VBar = { label: string; value: number; text: string; note?: React.ReactNode; color: string; dot?: string };

/** Vertical bars with a horizontal reference line (average) across each bar, as in the reference design. */
function VBars({ items, height, ref_label, highlightLast }: { items: VBar[]; height: number; ref_label?: string; highlightLast?: boolean }) {
  const max = Math.max(...items.map((i) => i.value), 1) * 1.08;
  const base = highlightLast ? items.slice(0, -1) : items;
  const avg = base.reduce((a, b) => a + b.value, 0) / (base.length || 1);
  return (
    <div>
      <div className="relative flex items-end justify-around gap-3" style={{ height: height + 40 }}>
        {items.map((it, i) => (
          <div key={i} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end">
            <div className="mb-1 text-center">
              <div className="text-[12px] font-semibold text-white tnum">{it.text}</div>
              {it.note && <div className="text-[10px] leading-tight">{it.note}</div>}
            </div>
            <div className="relative w-full max-w-[56px]" style={{ height: `${(it.value / max) * height}px`, background: it.color }}>
              <span className="absolute -inset-x-2 h-[1.5px] bg-white/55" style={{ bottom: `${(avg / it.value) * 100}%` }}
                hidden={!it.value || avg > it.value * 1.4} />
            </div>
          </div>
        ))}
      </div>
      <div className="mt-2 flex justify-around gap-3">
        {items.map((it, i) => (
          <div key={i} className="flex min-w-0 flex-1 items-center justify-center gap-1.5 truncate text-center text-[11px] text-mute">
            {it.dot && <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: it.dot }} />}{it.label}
          </div>
        ))}
      </div>
      {ref_label && <div className="mt-3 flex items-center justify-end gap-1.5 text-[10px] text-faint"><span className="h-[1.5px] w-4 bg-white/55" />{ref_label}</div>}
    </div>
  );
}

function BusiestStores({ rows }: { rows: Summary["heatmap"] }) {
  const stores = rows.map((r) => ({ ...r, total: r.values.reduce((a, b) => a + b, 0) }))
    .sort((a, b) => b.total - a.total).slice(0, 4);
  const all = rows.reduce((a, r) => a + r.values.reduce((x, y) => x + y, 0), 0) || 1;
  return (
    <div>
      <VBars height={120}
        items={stores.map((s) => ({
          label: s.store_id, value: s.total, text: money(s.total), color: "var(--data)",
          note: <span className="text-good">▲ {((s.total / all) * 100).toFixed(1)}%</span>,
        }))} />
      <div className="mt-3 flex justify-around gap-3">
        {stores.map((s) => (
          <div key={s.store_id} className="flex flex-1 justify-center">
            <span className="grid h-9 w-9 place-items-center rounded-full text-[11px] font-bold text-black ring-2 ring-white/80"
              style={{ background: PLATFORM_VAR[s.platform] }} title={`${s.city} · ${platformLabel(s.platform)}`}>
              {s.city.slice(0, 3).toUpperCase()}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function HBars({ items }: { items: { label: string; value: number; text: string; share: number }[] }) {
  const max = Math.max(...items.map((i) => i.value), 1);
  const avg = items.reduce((a, b) => a + b.value, 0) / (items.length || 1);
  return (
    <div className="space-y-3">
      {items.map((it) => (
        <div key={it.label} className="grid grid-cols-[110px_1fr] items-center gap-3">
          <div className="truncate text-right text-[11.5px] text-mute" title={it.label}>{it.label}</div>
          <div className="flex items-center gap-2">
            <div className="relative h-[26px] bg-data" style={{ width: `${(it.value / max) * 62}%` }}>
              <span className="absolute -inset-y-1 w-[1.5px] bg-white/60" style={{ left: `${Math.min(100, (avg / it.value) * 100)}%` }} />
            </div>
            <span className="text-[12px] font-semibold text-white tnum">{it.text}</span>
            <span className="text-[10px] text-good">▲{it.share}%</span>
          </div>
        </div>
      ))}
      <div className="flex items-center justify-end gap-1.5 pt-1 text-[10px] text-faint"><span className="h-3 w-[1.5px] bg-white/60" />avg of top 5 · % = share of revenue</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// city bubble map (coarse India outline, equirectangular)
// ---------------------------------------------------------------------------
const INDIA: [number, number][] = [
  [68.2, 23.7], [68.8, 22.3], [70.1, 21.0], [72.6, 21.2], [72.9, 19.0], [73.4, 16.0], [74.6, 13.0], [75.9, 11.0],
  [76.9, 8.3], [77.6, 8.1], [78.2, 9.2], [79.3, 10.3], [79.9, 12.0], [80.3, 13.6], [80.2, 15.6], [81.3, 16.6],
  [82.3, 17.0], [84.1, 18.3], [85.3, 19.6], [86.9, 20.8], [87.3, 21.6], [88.2, 21.8], [89.0, 22.1], [88.8, 24.2],
  [88.0, 25.2], [89.8, 26.0], [92.0, 26.9], [94.0, 27.6], [95.4, 28.2], [97.0, 28.3], [96.0, 27.3], [95.2, 26.0],
  [94.3, 25.2], [93.4, 23.8], [92.6, 21.9], [92.0, 23.5], [91.2, 23.2], [90.6, 23.9], [89.8, 25.3], [89.0, 25.9],
  [88.4, 26.5], [87.9, 27.4], [88.2, 28.0], [86.3, 27.9], [84.2, 27.4], [83.3, 27.3], [81.1, 28.7], [80.0, 30.2],
  [78.9, 31.3], [78.4, 32.6], [79.4, 33.3], [78.8, 34.3], [77.8, 35.5], [76.2, 35.9], [74.5, 35.0], [73.8, 34.4],
  [74.4, 33.0], [75.0, 32.3], [74.6, 31.8], [73.9, 30.2], [72.8, 28.9], [71.0, 27.8], [70.1, 27.1], [69.5, 26.5],
  [70.3, 25.6], [71.1, 24.4], [68.8, 24.3],
];
const CITY_LL: Record<string, [number, number]> = {
  Bengaluru: [77.59, 12.97], Mumbai: [72.88, 19.08], Delhi: [77.21, 28.61],
  Hyderabad: [78.49, 17.39], Pune: [73.86, 18.52], Chennai: [80.27, 13.08],
};

function CityMap({ cities }: { cities: Summary["by_city"] }) {
  const [hover, setHover] = useState<string | null>(null);
  const W = 230, H = 250, lon0 = 67.5, lon1 = 97.5, lat0 = 7.5, lat1 = 36.5;
  const px = (lon: number, lat: number): [number, number] => [((lon - lon0) / (lon1 - lon0)) * W, H - ((lat - lat0) / (lat1 - lat0)) * H];
  const max = Math.max(...cities.map((c) => c.revenue), 1);
  const top3 = cities.slice(0, 3);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_128px] items-center gap-3">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-[210px] w-full">
        <path d={INDIA.map(([lo, la], i) => `${i ? "L" : "M"}${px(lo, la).join(",")}`).join(" ") + "Z"}
          fill="#4a4a4e" stroke="#6a6a70" strokeWidth="0.8" strokeLinejoin="round" />
        {cities.map((c, i) => {
          const ll = CITY_LL[c.city];
          if (!ll) return null;
          const [x, y] = px(...ll);
          const r = 5 + (c.revenue / max) * 11;
          return (
            <g key={c.city} onMouseEnter={() => setHover(c.city)} onMouseLeave={() => setHover(null)} className="cursor-default">
              <circle cx={x} cy={y} r={r} fill={i === 0 ? "var(--accent)" : "#b9b9c0"} fillOpacity={i === 0 ? 0.9 : 0.75}
                stroke="#fff" strokeOpacity={hover === c.city ? 1 : 0.5} strokeWidth="1" />
              {hover === c.city && (
                <text x={x} y={y - r - 4} textAnchor="middle" fontSize="10" fill="#fff" fontWeight="600">{c.city} · {money(c.revenue)}</text>
              )}
            </g>
          );
        })}
      </svg>
      <div>
        <div className="mb-3 inline-block bg-[#4a4a4e] px-2 py-0.5 text-[10px] text-white">Top 3 cities</div>
        <ol className="space-y-3.5">
          {top3.map((c, i) => (
            <li key={c.city} className="flex items-start gap-2.5">
              <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-[#4a4a4e] text-[10px] font-bold text-white">{i + 1}</span>
              <div>
                <div className="text-[12.5px] text-white">{c.city}</div>
                <div className="text-[12px] font-semibold text-white/80 tnum">{money(c.revenue)}</div>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
