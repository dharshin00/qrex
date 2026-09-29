"use client";

import { useState } from "react";
import { useLive, useNow } from "@/lib/api";
import {
  Card, Empty, ErrorNote, Mini, PageHeader, PlatformTag, Segmented, SkeletonPage, Status, ago, num,
} from "@/components/ui";

type Item = { sku: string; canonical_sku: string | null; product_name: string; units: number };
type Store = {
  platform: string; store_id: string; city: string; threshold: number; sku_count: number;
  total_units: number; low_stock: Item[]; stock_out: Item[]; as_of: string; items: Item[];
};

/** Cell colour: stock-out = bad, below threshold = warn, otherwise grey → indigo by depth (same scale as Summary). */
function cellStyle(units: number, threshold: number, max: number) {
  if (units === 0) return { background: "var(--bad)" };
  if (units < threshold) return { background: "var(--warn)" };
  const depth = Math.min(1, units / max);
  return { background: `color-mix(in srgb, var(--accent) ${Math.round(depth * 100)}%, #6e6e74)` };
}

export default function WarehousesPage() {
  const { data, error } = useLive<Store[]>("/warehouses");
  const [platform, setPlatform] = useState<"all" | "blinkit" | "instamart">("all");
  const [issues, setIssues] = useState<"all" | "issues">("all");
  const [open, setOpen] = useState<string | null>(null);
  const now = useNow(10000);

  if (!data) return error ? <ErrorNote error={error} /> : <SkeletonPage />;

  const max = Math.max(1, ...data.flatMap((s) => s.items.map((i) => i.units)));
  const stores = data
    .filter((s) => platform === "all" || s.platform === platform)
    .filter((s) => issues === "all" || s.low_stock.length + s.stock_out.length > 0)
    .sort((a, b) => (b.stock_out.length * 10 + b.low_stock.length) - (a.stock_out.length * 10 + a.low_stock.length));
  const outs = data.reduce((a, s) => a + s.stock_out.length, 0);
  const lows = data.reduce((a, s) => a + s.low_stock.length, 0);

  return (
    <div>
      <PageHeader kicker="Warehouses & dark stores"
        title={outs ? `${outs} stock-out${outs > 1 ? "s" : ""} right now.` : lows ? `${lows} SKU${lows > 1 ? "s" : ""} running low.` : "Every shelf is stocked."}
        sub="Each tile is one location; each square is one SKU, coloured by how deep its stock is." />
      <ErrorNote error={error} />

      <div className="mb-6 grid grid-cols-2 gap-2.5 md:grid-cols-4">
        <Mini label="Locations" value={data.length} note="dark stores & warehouses" />
        <Mini label="Units on hand" value={num(data.reduce((a, s) => a + s.total_units, 0))} note="all locations" />
        <Mini label="Stock-outs" value={outs} tone={outs ? "bad" : "good"} note="SKU × location at 0" />
        <Mini label="Low stock" value={lows} tone={lows ? "warn" : "good"} note="below threshold" />
      </div>

      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          <Segmented value={platform} onChange={setPlatform}
            options={[{ value: "all", label: "All platforms" }, { value: "blinkit", label: "Blinkit" }, { value: "instamart", label: "Instamart" }]} />
          <Segmented value={issues} onChange={setIssues}
            options={[{ value: "all", label: "All locations" }, { value: "issues", label: "With issues" }]} />
        </div>
        <div className="flex items-center gap-4 text-[12px] text-mute">
          <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5" style={{ background: "var(--bad)" }} />Out</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5" style={{ background: "var(--warn)" }} />Low</span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5" style={cellStyle(max * 0.2, 0, max)} />
            <span className="h-2.5 w-2.5" style={cellStyle(max, 0, max)} />Shallow → deep
          </span>
        </div>
      </div>

      {stores.length === 0 ? (
        <Card><Empty title="No locations with issues">Every SKU at every location is above its threshold.</Empty></Card>
      ) : (
        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          {stores.map((s) => {
            const id = s.platform + s.store_id;
            const issueItems = [...s.stock_out, ...s.low_stock];
            return (
              <section key={id} className="border bg-surface"
                style={{ borderColor: s.stock_out.length ? "color-mix(in srgb, var(--bad) 55%, transparent)"
                  : s.low_stock.length ? "color-mix(in srgb, var(--warn) 55%, transparent)" : "var(--line)" }}>
                <header className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
                  <div>
                    <div className="font-mono text-[14px] font-medium text-ink">{s.store_id}</div>
                    <div className="mt-1 flex items-center gap-3 text-[13px] text-mute">{s.city}<PlatformTag p={s.platform} /></div>
                  </div>
                  <div className="text-right">
                    <div className="font-display text-[22px] font-extrabold leading-none tracking-[-0.02em] tnum text-ink">{num(s.total_units)}</div>
                    <div className="label mt-1 text-faint">units</div>
                  </div>
                </header>
                <div className="px-5 py-4">
                  <div className="grid grid-cols-12 gap-[3px]">
                    {s.items.map((i) => (
                      <div key={i.sku} className="aspect-square transition hover:outline hover:outline-1 hover:outline-ink"
                        style={cellStyle(i.units, s.threshold, max)}
                        title={`${i.product_name} (${i.sku}) · ${i.units} units`} />
                    ))}
                  </div>
                  <div className="mt-4 min-h-[44px]">
                    {issueItems.length ? (
                      <ul className="space-y-1.5">
                        {issueItems.slice(0, 3).map((i) => (
                          <li key={i.sku} className="flex items-center justify-between gap-2 text-[13px]">
                            <span className="truncate text-ink">{i.product_name}</span>
                            <Status tone={i.units === 0 ? "bad" : "warn"}>{i.units === 0 ? "Out" : `${i.units} left`}</Status>
                          </li>
                        ))}
                        {issueItems.length > 3 && <li className="text-[12px] text-faint">+{issueItems.length - 3} more</li>}
                      </ul>
                    ) : <Status tone="good">All {s.sku_count} SKUs above {s.threshold}</Status>}
                  </div>
                </div>
                <footer className="flex items-center justify-between border-t border-line px-5 py-2.5">
                  <span className="text-[12px] text-faint">changed {ago(s.as_of, now)}</span>
                  <button className="label text-faint hover:text-accent" onClick={() => setOpen(open === id ? null : id)}>
                    {open === id ? "Hide SKUs" : "All SKUs"}
                  </button>
                </footer>
                {open === id && (
                  <table className="rise w-full border-t border-line text-[13px]">
                    <tbody className="divide-y divide-line">
                      {[...s.items].sort((a, b) => a.units - b.units).map((i) => (
                        <tr key={i.sku}>
                          <td className="px-5 py-1.5 text-ink">{i.product_name}</td>
                          <td className="py-1.5 text-right font-mono text-[11px] text-faint">{i.sku}</td>
                          <td className="tnum px-5 py-1.5 text-right" style={{ color: i.units < s.threshold ? "var(--bad)" : "var(--mute)" }}>{i.units}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
