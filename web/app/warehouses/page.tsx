"use client";

import { useState } from "react";
import { useLive, useNow } from "@/lib/api";
import { Badge, Card, Empty, ErrorNote, PageHeader, PlatformTag, ago } from "@/components/ui";

type Item = { sku: string; canonical_sku: string | null; product_name: string; units: number };
type Store = {
  platform: string; store_id: string; city: string; threshold: number; sku_count: number;
  total_units: number; low_stock: Item[]; stock_out: Item[]; as_of: string; items: Item[];
};

export default function WarehousesPage() {
  const { data, error } = useLive<Store[]>("/warehouses");
  const [open, setOpen] = useState<string | null>(null);
  const [onlyIssues, setOnlyIssues] = useState(false);
  const now = useNow(10000);
  const stores = (data ?? []).filter((s) => !onlyIssues || s.low_stock.length + s.stock_out.length > 0);

  return (
    <div className="space-y-4">
      <PageHeader title="Warehouses & dark stores"
        sub="Stock per location. Items below the connector's low-stock threshold are highlighted."
        action={
          <label className="flex items-center gap-2 text-sm text-mute">
            <input type="checkbox" checked={onlyIssues} onChange={(e) => setOnlyIssues(e.target.checked)} />
            Only locations with issues
          </label>
        } />
      <ErrorNote error={error} />
      {!data ? <Empty>Loading…</Empty> : stores.length === 0 ? <Empty>No locations{onlyIssues ? " with issues" : ""}.</Empty> : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {stores.map((s) => {
            const id = s.platform + s.store_id;
            const issues = [...s.stock_out, ...s.low_stock];
            return (
              <Card key={id}
                className={s.stock_out.length ? "border-bad/50" : s.low_stock.length ? "border-warn/50" : ""}
                title={<span className="font-mono">{s.store_id}</span>}
                action={<PlatformTag p={s.platform} />}>
                <div className="flex items-baseline justify-between text-sm">
                  <span className="text-mute">{s.city}</span>
                  <span className="text-xs text-mute">updated {ago(s.as_of, now)}</span>
                </div>
                <div className="mt-2 flex gap-4 text-sm">
                  <div><div className="text-xs text-mute">Units</div><b className="tabular-nums">{s.total_units.toLocaleString()}</b></div>
                  <div><div className="text-xs text-mute">SKUs</div><b>{s.sku_count}</b></div>
                  <div><div className="text-xs text-mute">Threshold</div><b>{s.threshold}</b></div>
                </div>
                {issues.length > 0 ? (
                  <ul className="mt-3 space-y-1">
                    {issues.map((i) => (
                      <li key={i.sku} className="flex items-center justify-between gap-2 text-sm">
                        <span className="truncate">{i.product_name}</span>
                        <Badge tone={i.units === 0 ? "bad" : "warn"}>{i.units === 0 ? "STOCK OUT" : `${i.units} left`}</Badge>
                      </li>
                    ))}
                  </ul>
                ) : <p className="mt-3 text-sm text-good">All SKUs above threshold.</p>}
                <button className="mt-3 text-xs text-accent" onClick={() => setOpen(open === id ? null : id)}>
                  {open === id ? "Hide" : "Show"} all {s.sku_count} SKUs
                </button>
                {open === id && (
                  <table className="mt-2 w-full text-xs">
                    <tbody>
                      {[...s.items].sort((a, b) => a.units - b.units).map((i) => (
                        <tr key={i.sku} className="border-t border-line">
                          <td className="py-1 pr-2">{i.product_name}</td>
                          <td className="py-1 text-right font-mono text-mute">{i.sku}</td>
                          <td className={`py-1 pl-2 text-right tabular-nums ${i.units < s.threshold ? "font-semibold text-bad" : ""}`}>{i.units}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
