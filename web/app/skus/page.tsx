"use client";

import { useMemo, useState } from "react";
import { useLive } from "@/lib/api";
import { Badge, Card, Empty, ErrorNote, PLATFORM_COLOR, PageHeader, inr } from "@/components/ui";

type PlatformCell = { sku: string; units?: number; units_sold_7d?: number; revenue_7d?: number; source_path?: string };
type Sku = {
  canonical_sku: string | null;
  key: string;
  product_name: string;
  platforms: Record<string, PlatformCell>;
  total_units: number;
  units_sold_7d: number;
  revenue_7d: number;
  days_of_cover: number | null;
  low_stock_locations: { platform: string; store_id: string; city: string; units: number }[];
};

const PLATFORMS = ["blinkit", "instamart"];

export default function SkusPage() {
  const { data, error } = useLive<Sku[]>("/skus");
  const [q, setQ] = useState("");
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (data ?? []).filter((r) => !s || r.product_name.toLowerCase().includes(s) || r.key.toLowerCase().includes(s)
      || Object.values(r.platforms).some((p) => p.sku.toLowerCase().includes(s)));
  }, [data, q]);

  return (
    <div className="space-y-4">
      <PageHeader title="Unified SKUs"
        sub="One row per physical product. Platform SKUs are resolved to a canonical SKU via sku_map." />
      <ErrorNote error={error} />
      <Card title={`${rows.length} products`}
        action={<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or SKU"
          className="w-48 rounded-lg border border-line bg-bg px-3 py-1.5 text-sm outline-none focus:border-accent" />}>
        {!data ? <Empty>Loading…</Empty> : rows.length === 0 ? <Empty>No products match.</Empty> : (
          <div className="-mx-4 overflow-x-auto">
            <table className="w-full min-w-[860px] text-sm">
              <thead className="text-left text-xs text-mute">
                <tr className="border-b border-line">
                  <th className="px-4 py-2 font-medium">Product</th>
                  {PLATFORMS.map((p) => (
                    <th key={p} className="px-3 py-2 text-right font-medium">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="h-2 w-2 rounded-full" style={{ background: PLATFORM_COLOR[p] }} />
                        {p === "blinkit" ? "Blinkit" : "Instamart"} stock · 7d sold
                      </span>
                    </th>
                  ))}
                  <th className="px-3 py-2 text-right font-medium">Total stock</th>
                  <th className="px-3 py-2 text-right font-medium">7d revenue</th>
                  <th className="px-3 py-2 text-right font-medium">Days of cover</th>
                  <th className="px-4 py-2 font-medium">Alerts</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key} className="border-b border-line last:border-0 hover:bg-hover">
                    <td className="px-4 py-2">
                      <div className="font-medium">{r.product_name}</div>
                      <div className="font-mono text-[11px] text-mute">
                        {r.canonical_sku ?? <span className="text-warn">unmapped</span>}
                      </div>
                    </td>
                    {PLATFORMS.map((p) => {
                      const c = r.platforms[p];
                      return (
                        <td key={p} className="px-3 py-2 text-right">
                          {c ? (
                            <>
                              <div className="tabular-nums">{c.units ?? "—"} · {c.units_sold_7d ?? 0}</div>
                              <div className="font-mono text-[11px] text-mute">{c.sku}</div>
                            </>
                          ) : <span className="text-mute">—</span>}
                        </td>
                      );
                    })}
                    <td className="px-3 py-2 text-right font-medium tabular-nums">{r.total_units.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{inr(r.revenue_7d)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {r.days_of_cover == null ? "—" : (
                        <span className={r.days_of_cover < 3 ? "font-semibold text-bad" : r.days_of_cover < 7 ? "text-warn" : ""}>
                          {r.days_of_cover}d
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      {r.low_stock_locations.length === 0 ? <span className="text-xs text-mute">—</span> : (
                        <div className="flex flex-wrap gap-1">
                          {r.low_stock_locations.map((l) => (
                            <Badge key={l.platform + l.store_id} tone={l.units === 0 ? "bad" : "warn"}>
                              {l.city} {l.units === 0 ? "out" : `${l.units} left`}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <p className="text-xs text-mute">Days of cover = total stock ÷ average daily units sold over the last 7 days.</p>
    </div>
  );
}
