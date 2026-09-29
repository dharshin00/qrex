"use client";

import { useMemo, useState } from "react";
import { useLive } from "@/lib/api";
import { Icon } from "@/components/icons";
import {
  Card, Empty, ErrorNote, Mini, PLATFORMS, PLATFORM_VAR, PageHeader, Segmented, ShareBar, SkeletonPage, Status,
  inr, inrShort, num, platformLabel,
} from "@/components/ui";

type PlatformCell = { sku: string; units?: number; units_sold_7d?: number; revenue_7d?: number };
type Sku = {
  canonical_sku: string | null; key: string; product_name: string; platforms: Record<string, PlatformCell>;
  total_units: number; units_sold_7d: number; revenue_7d: number; days_of_cover: number | null;
  low_stock_locations: { platform: string; store_id: string; city: string; units: number }[];
};
type SortKey = "name" | "stock" | "sold" | "revenue" | "cover";

const coverTone = (d: number | null) => (d == null ? "mute" : d < 3 ? "bad" : d < 7 ? "warn" : "good");

export default function SkusPage() {
  const { data, error } = useLive<Sku[]>("/skus");
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | "attention">("all");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "revenue", dir: -1 });

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    const val = (r: Sku) => ({
      name: r.product_name, stock: r.total_units, sold: r.units_sold_7d, revenue: r.revenue_7d,
      cover: r.days_of_cover ?? Infinity,
    })[sort.key];
    return (data ?? [])
      .filter((r) => !s || r.product_name.toLowerCase().includes(s) || r.key.toLowerCase().includes(s)
        || Object.values(r.platforms).some((p) => p.sku.toLowerCase().includes(s)))
      .filter((r) => filter === "all" || r.low_stock_locations.length > 0 || (r.days_of_cover ?? 99) < 7)
      .sort((a, b) => {
        const x = val(a), y = val(b);
        return (typeof x === "string" ? x.localeCompare(y as string) : (x as number) - (y as number)) * sort.dir;
      });
  }, [data, q, filter, sort]);

  if (!data) return error ? <ErrorNote error={error} /> : <SkeletonPage />;

  const totalUnits = data.reduce((a, r) => a + r.total_units, 0);
  const totalRev = data.reduce((a, r) => a + r.revenue_7d, 0);
  const attention = data.filter((r) => r.low_stock_locations.length > 0 || (r.days_of_cover ?? 99) < 7).length;
  const unmapped = data.filter((r) => !r.canonical_sku).length;

  const Th = ({ k, children, right }: { k: SortKey; children: React.ReactNode; right?: boolean }) => (
    <th className={`label px-3 py-3 font-normal text-faint ${right ? "text-right" : "text-left"}`}>
      <button onClick={() => setSort((s) => ({ key: k, dir: s.key === k ? (-s.dir as 1 | -1) : k === "name" ? 1 : -1 }))}
        className={`inline-flex items-center gap-1 hover:text-ink ${sort.key === k ? "text-ink" : ""}`}>
        {children}{sort.key === k && <span className="text-accent">{sort.dir === 1 ? "↑" : "↓"}</span>}
      </button>
    </th>
  );

  return (
    <div>
      <PageHeader kicker="Unified SKUs" title="One product, every platform."
        sub="Platform SKUs are resolved to a canonical SKU, so stock and sales read as one row per physical product." />
      <ErrorNote error={error} />

      <div className="mb-6 grid grid-cols-2 gap-2.5 md:grid-cols-4">
        <Mini label="Products" value={num(data.length)} note={unmapped ? `${unmapped} unmapped` : "all mapped"} />
        <Mini label="Units in stock" value={num(totalUnits)} note="across both platforms" />
        <Mini label="Revenue · 7d" value={inrShort(totalRev)} note="all SKUs" />
        <Mini label="Need attention" value={attention} note="low stock or < 7 days cover" tone={attention ? "warn" : "good"} />
      </div>

      <Card pad={false}
        title={`${rows.length} products`}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Segmented value={filter} onChange={setFilter}
              options={[{ value: "all", label: "All" }, { value: "attention", label: "Needs attention" }]} />
            <label className="flex h-8 items-center gap-2 border border-line-strong px-2.5 focus-within:border-accent">
              <Icon name="search" size={14} className="text-faint" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or SKU"
                className="w-40 bg-transparent text-[13px] text-ink outline-none placeholder:text-faint" />
            </label>
          </div>
        }>
        {rows.length === 0 ? <Empty icon="search" title="No products match">Try a different search or filter.</Empty> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[960px] text-[14px]">
              <thead className="border-b border-line">
                <tr>
                  <Th k="name"><span className="pl-2">Product</span></Th>
                  <th className="label px-3 py-3 text-left font-normal text-faint">Stock split</th>
                  {PLATFORMS.map((p) => (
                    <th key={p} className="label px-3 py-3 text-right font-normal text-faint">
                      <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2" style={{ background: PLATFORM_VAR[p] }} />{platformLabel(p)}</span>
                    </th>
                  ))}
                  <Th k="stock" right>Stock</Th>
                  <Th k="sold" right>Sold · 7d</Th>
                  <Th k="revenue" right>Revenue · 7d</Th>
                  <Th k="cover" right>Cover</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((r) => (
                  <tr key={r.key} className="hover:bg-hover/60">
                    <td className="px-5 py-3">
                      <div className="font-medium text-ink">{r.product_name}</div>
                      <div className="mt-0.5 flex items-center gap-2 font-mono text-[11px] text-faint">
                        {r.canonical_sku ?? <span className="text-warn">UNMAPPED</span>}
                        {r.low_stock_locations.map((l) => (
                          <span key={l.platform + l.store_id} className="font-sans" style={{ color: l.units === 0 ? "var(--bad)" : "var(--warn)" }}>
                            · {l.city} {l.units === 0 ? "out" : `${l.units} left`}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="w-[150px] px-3 py-3">
                      <ShareBar parts={PLATFORMS.map((p) => ({ label: platformLabel(p), value: r.platforms[p]?.units ?? 0, color: PLATFORM_VAR[p] }))} />
                    </td>
                    {PLATFORMS.map((p) => {
                      const c = r.platforms[p];
                      return (
                        <td key={p} className="px-3 py-3 text-right">
                          {c ? (
                            <>
                              <div className="tnum text-ink">{c.units != null ? num(c.units) : "—"}</div>
                              <div className="font-mono text-[11px] text-faint">{c.sku}</div>
                            </>
                          ) : <span className="text-faint">—</span>}
                        </td>
                      );
                    })}
                    <td className="tnum px-3 py-3 text-right font-medium text-ink">{num(r.total_units)}</td>
                    <td className="tnum px-3 py-3 text-right text-mute">{num(r.units_sold_7d)}</td>
                    <td className="tnum px-3 py-3 text-right text-mute">{inr(r.revenue_7d)}</td>
                    <td className="px-5 py-3 text-right">
                      {r.days_of_cover == null ? <span className="text-faint">—</span>
                        : <Status tone={coverTone(r.days_of_cover)}>{r.days_of_cover}d</Status>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <p className="mt-3 text-[12px] text-faint">Cover = stock ÷ average daily units sold over the last 7 days. Under 3 days is critical, under 7 is a warning.</p>
    </div>
  );
}

