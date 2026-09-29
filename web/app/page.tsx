"use client";

import Link from "next/link";
import { useLive, useNow, type Freshness } from "@/lib/api";
import {
  Badge, Bars, Card, ErrorNote, PAGE_MOCK_URL, PLATFORM_COLOR, PageHeader, Stat, ago, inr,
  platformLabel, statusTone,
} from "@/components/ui";

type Overview = {
  connectors: { platform: string; display_name: string; status: string; freshness: Freshness[] }[];
  open_alerts: Record<string, number>;
  open_alerts_by_kind: Record<string, number>;
  interventions_per_week: { week: string; count: number; gap_minutes_recovered: number }[];
  gap_minutes_recovered_total: number;
  clean_row_counts: Record<string, number>;
  duplicate_clean_rows: number;
  orders_24h: Record<string, { orders: number; revenue: number }>;
  sales_trend: ({ date: string } & Record<string, { units: number; revenue: number } | string>)[];
};

const DS_LABEL: Record<string, string> = {
  orders: "Orders", inventory: "Inventory", warehouse_stock: "Warehouse stock", sales: "Sales",
};

export default function OverviewPage() {
  const { data, error } = useLive<Overview>("/metrics/overview");
  const now = useNow(5000);
  if (!data) return <div className="text-sm text-mute">{error ? <ErrorNote error={error} /> : "Loading…"}</div>;

  const orders = Object.values(data.orders_24h).reduce((a, b) => a + b.orders, 0);
  const revenue = Object.values(data.orders_24h).reduce((a, b) => a + b.revenue, 0);
  const critical = data.open_alerts.critical ?? 0;
  const warn = data.open_alerts.warn ?? 0;
  const paused = data.connectors.filter((c) => c.status === "paused");

  return (
    <div className="space-y-5">
      <PageHeader title="Overview" sub="Freshness, alerts and the interventions trend across all platforms." />
      <ErrorNote error={error} />

      {paused.map((c) => (
        <div key={c.platform} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-bad/40 bg-bad/10 px-4 py-3 text-sm">
          <span>
            <b>{c.display_name}</b> is paused: the seller session expired. Data below is the last good copy, marked stale.
          </span>
          <Link href={`/connectors/${c.platform}/reauth`} className="rounded-lg bg-bad px-3 py-1.5 font-medium text-white">
            Re-authenticate
          </Link>
        </div>
      ))}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Orders (24h)" value={orders.toLocaleString()} sub={inr(revenue) + " revenue"} />
        <Stat label="Open alerts" value={critical + warn} tone={critical ? "bad" : warn ? "warn" : "good"}
          sub={`${critical} critical · ${warn} warning`} />
        <Stat label="Duplicate clean rows" value={data.duplicate_clean_rows}
          tone={data.duplicate_clean_rows ? "bad" : "good"} sub="idempotent upserts" />
        <Stat label="Reporting gap recovered" value={`${data.gap_minutes_recovered_total} min`}
          sub="backfilled after re-auth" />
      </div>

      <Card title="Source freshness">
        <div className="grid gap-4 md:grid-cols-2">
          {data.connectors.map((c) => (
            <div key={c.platform}>
              <div className="mb-2 flex items-center justify-between">
                <span className="inline-flex items-center gap-2 text-sm font-medium">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: PLATFORM_COLOR[c.platform] }} />
                  {c.display_name}
                </span>
                <Badge tone={statusTone(c.status)}>{c.status}</Badge>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {c.freshness.map((f) => {
                  const age = f.last_success_at ? ago(f.last_success_at, now) : "never";
                  return (
                    <div key={f.dataset} className="rounded-lg border border-line p-3">
                      <div className="flex items-center justify-between gap-1">
                        <span className="text-xs text-mute">{DS_LABEL[f.dataset]}</span>
                        <Badge tone={statusTone(f.state)}>{f.state}</Badge>
                      </div>
                      <div className="mt-1 text-sm font-medium">synced {age}</div>
                      <div className="mt-0.5 truncate text-[11px] text-mute" title={f.last_error ?? ""}>
                        {f.last_status && f.last_status !== "success"
                          ? `last run ${f.last_status}`
                          : `via ${f.last_source_path?.toLowerCase().replace("_", " ") ?? "—"}`}
                        {" · SLA "}{Math.round(f.sla_seconds / 60)}m
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Manual interventions per week"
          action={<span className="text-xs text-mute">lower is better</span>}>
          <Bars height={150}
            data={data.interventions_per_week.map((w) => ({
              label: new Date(w.week).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
              values: { n: w.count },
            }))}
            series={[{ key: "n", color: "var(--accent)", label: "interventions" }]} />
          <p className="mt-2 text-xs text-mute">
            Weeks before the current one include seeded baseline data representing the manual workflow Q-REX replaces.
          </p>
        </Card>
        <Card title="Daily sales units by platform">
          <Bars height={150}
            data={data.sales_trend.map((d) => ({
              label: new Date(d.date + "T00:00:00").toLocaleDateString(undefined, { weekday: "short" }),
              values: Object.fromEntries(Object.keys(PLATFORM_COLOR).map((p) => {
                const v = d[p] as { units: number } | undefined;
                return [p, v?.units ?? 0];
              })),
            }))}
            series={Object.entries(PLATFORM_COLOR).map(([k, color]) => ({ key: k, color, label: platformLabel(k) }))} />
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Open alerts by kind" action={<Link href="/alerts" className="text-xs text-accent">All alerts →</Link>}>
          {Object.keys(data.open_alerts_by_kind).length === 0 ? (
            <p className="text-sm text-good">No open alerts.</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {Object.entries(data.open_alerts_by_kind).map(([k, n]) => (
                <li key={k} className="flex justify-between"><span className="font-mono text-xs">{k}</span><b>{n}</b></li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Clean layer">
          <ul className="space-y-1.5 text-sm">
            {Object.entries(data.clean_row_counts).map(([k, n]) => (
              <li key={k} className="flex justify-between"><span>{DS_LABEL[k]}</span><b className="tabular-nums">{n.toLocaleString()}</b></li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-mute">
            Keyed on (platform, external_id, sku). Inject faults from the{" "}
            <a className="text-accent" href={PAGE_MOCK_URL} target="_blank" rel="noreferrer">chaos panel</a> and watch these hold.
          </p>
        </Card>
      </div>
    </div>
  );
}
