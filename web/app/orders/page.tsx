"use client";

import { useState } from "react";
import { useLive, useNow } from "@/lib/api";
import { usePlatformFilter } from "@/lib/filter";
import { AreaChart } from "@/components/charts";
import { Icon } from "@/components/icons";
import { Empty, ErrorNote, PLATFORM_VAR, Segmented, platformLabel } from "@/components/ui";

type OrderRow = {
  platform: string; order_id: string; store_id: string; city: string; ordered_at: string; status: string;
  lines: number; units: number; amount: number; products: string[]; source_path: string;
};
type Hourly = { hours: string[]; series: Record<string, { orders: number; revenue: number }[]> };

const STATUS: Record<string, { label: string; bg: string; fg: string }> = {
  placed: { label: "PLACED", bg: "#6b5a2a", fg: "#f7d98a" },
  in_transit: { label: "IN TRANSIT", bg: "#3d4580", fg: "#b9bfff" },
  delivered: { label: "DELIVERED", bg: "#1f5a4a", fg: "#8ff0cf" },
};
const DELIVERY_MIN = 20;

/** Ring gauge: delivery progress (placed → in transit at 3 min → delivered at 20 min). */
function Ring({ pct }: { pct: number }) {
  const r = 12, c = 2 * Math.PI * r;
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" className="shrink-0" aria-label={`${pct}% delivered`}>
      <circle cx="16" cy="16" r={r} fill="none" stroke="#4a4a4e" strokeWidth="3" />
      <circle cx="16" cy="16" r={r} fill="none" stroke="var(--good)" strokeWidth="3" strokeLinecap="round"
        strokeDasharray={`${(pct / 100) * c} ${c}`} transform="rotate(-90 16 16)" />
      <text x="16" y="19" textAnchor="middle" fontSize="8" fill="var(--mute)">{pct}%</text>
    </svg>
  );
}

export default function OrdersPage() {
  const [platform] = usePlatformFilter();
  const [status, setStatus] = useState<"" | "placed" | "in_transit" | "delivered">("");
  const [q, setQ] = useState("");
  const [limit, setLimit] = useState(40);
  const params = new URLSearchParams(Object.entries({ platform, status, q: q.trim(), limit: String(limit) }).filter(([, v]) => v));
  const { data, error } = useLive<{ total: number; items: OrderRow[] }>(`/orders?${params}`);
  const { data: hourly } = useLive<Hourly>("/metrics/orders_hourly?hours=168");
  const now = useNow(10000);

  const series = hourly
    ? hourly.hours.map((_, i) => Object.entries(hourly.series)
        .filter(([p]) => !platform || p === platform)
        .reduce((a, [, s]) => a + (s[i]?.orders ?? 0), 0))
    : [];

  return (
    <div>
      <div className="mb-14 min-h-[120px] md:mb-[72px]">
        <h1 className="text-[34px] font-semibold leading-tight tracking-[-0.01em] text-white md:text-[42px]">Order Details</h1>
        <p className="mt-2 text-[14px] text-white/70">
          {data ? `${data.total.toLocaleString("en-IN")} orders` : "Orders"} in the clean layer · {platform ? platformLabel(platform) : "all platforms"}
        </p>
      </div>
      <ErrorNote error={error} />

      {/* area chart */}
      <section className="bg-surface px-6 pb-6 pt-5 md:px-11">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[14px] font-semibold text-white">Orders per hour · last 7 days</h2>
          <span className="text-[11.5px] text-faint">{series.length ? `peak ${Math.max(...series)} / hour` : ""}</span>
        </div>
        {hourly ? (
          <AreaChart height={90} values={series} tickEvery={24}
            labels={hourly.hours.map((h) => new Date(h).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }))}
            tickLabel={(_, i) => new Date(hourly.hours[i]).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}
            format={(n) => `${n} orders`} />
        ) : <div className="skeleton h-[110px]" />}
      </section>

      {/* table */}
      <section className="mt-2.5 bg-surface">
        <div className="flex flex-wrap items-center justify-between gap-3 px-6 pt-5 md:px-8">
          <Segmented value={status} onChange={(v) => { setStatus(v); setLimit(40); }}
            options={[{ value: "", label: "All" }, { value: "placed", label: "Placed" }, { value: "in_transit", label: "In transit" }, { value: "delivered", label: "Delivered" }]} />
          <label className="flex h-8 items-center gap-2 rounded-md bg-black/40 px-2.5 ring-1 ring-white/10 focus-within:ring-accent">
            <Icon name="search" size={14} className="text-faint" />
            <input value={q} onChange={(e) => { setQ(e.target.value); setLimit(40); }} placeholder="Order ID or store"
              className="w-40 bg-transparent text-[13px] text-white outline-none placeholder:text-faint" />
          </label>
        </div>

        {!data ? <div className="space-y-2 p-8">{[0, 1, 2, 3, 4].map((i) => <div key={i} className="skeleton h-12" />)}</div>
          : data.items.length === 0 ? <Empty icon="doc" title="No orders match">Try another status or search.</Empty> : (
          <div className="mt-2 max-h-[560px] overflow-auto px-2 md:px-3">
            <table className="w-full min-w-[1040px] text-[13px]">
              <thead className="sticky top-0 z-[1] bg-surface">
                <tr className="text-[11.5px] uppercase text-mute">
                  <th className="px-4 py-4 text-left font-medium">Order ID</th>
                  <th className="px-3 py-4 text-left font-medium">Products</th>
                  <th className="px-3 py-4 text-center font-medium">Location</th>
                  <th className="px-3 py-4 text-center font-medium"># Items <span className="px-1 text-faint">|</span> Amount</th>
                  <th className="px-3 py-4 text-center font-medium">Delivery</th>
                  <th className="px-4 py-4 text-center font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((o) => {
                  const ageMin = (now - new Date(o.ordered_at).getTime()) / 60000;
                  const pct = o.status === "delivered" ? 100 : Math.max(1, Math.min(99, Math.round((ageMin / DELIVERY_MIN) * 100)));
                  const st = STATUS[o.status] ?? { label: o.status.toUpperCase(), bg: "#4a4a4e", fg: "#ddd" };
                  return (
                    <tr key={o.platform + o.order_id} className="border-t-2 border-black/60 hover:bg-white/[0.03]">
                      <td className="whitespace-nowrap px-4 py-3">
                        <div className="font-semibold text-white">{o.order_id}</div>
                        <div className="text-[11.5px] text-faint">
                          {new Date(o.ordered_at).toLocaleString(undefined, { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-3">
                          <span className="grid h-7 w-9 shrink-0 place-items-center text-[9.5px] font-bold text-black"
                            style={{ background: PLATFORM_VAR[o.platform] }} title={platformLabel(o.platform)}>
                            {o.platform === "blinkit" ? "BLK" : "IM"}
                          </span>
                          <div className="min-w-0">
                            <div className="max-w-[260px] truncate text-white">{o.products[0] ?? "—"}</div>
                            {o.products.length > 1 && <div className="text-[11.5px] text-faint">+{o.products.length - 1} more item{o.products.length > 2 ? "s" : ""}</div>}
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-3 text-center">
                        <div className="text-white">{o.city} <span className="text-faint">|</span> {platformLabel(o.platform)}</div>
                        <div className="text-[11.5px] text-faint">{o.store_id}</div>
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex items-center justify-center gap-4">
                          <span className="grid h-6 w-6 place-items-center rounded-full bg-[#5a5a60] text-[11px] font-semibold text-white">{o.units}</span>
                          <span className="w-[76px] font-medium text-white tnum">₹{o.amount.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</span>
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex items-center justify-center gap-3">
                          <Ring pct={pct} />
                          <span className="w-[74px] text-[12.5px] font-medium text-good">
                            {o.status === "delivered" ? "Delivered" : `${Math.max(0, Math.ceil(DELIVERY_MIN - ageMin))} min left`}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span className="inline-block min-w-[92px] px-3 py-1.5 text-[10px] font-semibold tracking-wide" style={{ background: st.bg, color: st.fg }}>
                          {st.label}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t-2 border-black/60 px-6 py-4 text-[12px] text-mute md:px-8">
          <span>Ring shows delivery progress: placed → in transit after 3 min → delivered at 20 min.</span>
          {data && data.items.length < data.total && (
            <button onClick={() => setLimit((l) => Math.min(l + 40, 200))} disabled={limit >= 200}
              className="font-medium text-accent hover:underline disabled:text-faint">
              {limit >= 200 ? "Showing the latest 200" : `Show more (${data.items.length} of ${data.total.toLocaleString("en-IN")})`}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
