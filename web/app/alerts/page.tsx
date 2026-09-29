"use client";

import Link from "next/link";
import { useState } from "react";
import { post, useLive, useNow, type AlertT } from "@/lib/api";
import { Badge, Button, Card, Empty, ErrorNote, PageHeader, PlatformTag, ago, fmtTime } from "@/components/ui";

const SEV_TONE = { critical: "bad", warn: "warn", info: "info" } as const;

export default function AlertsPage() {
  const [status, setStatus] = useState<"open" | "resolved" | "all">("open");
  const { data, error, reload } = useLive<AlertT[]>(`/alerts?status=${status}`);
  const [busy, setBusy] = useState<number | null>(null);
  const now = useNow(10000);

  async function resolve(id: number) {
    setBusy(id);
    try { await post(`/alerts/${id}/resolve`); await reload(); } finally { setBusy(null); }
  }

  return (
    <div className="space-y-4">
      <PageHeader title="Alerts"
        sub="One open alert per condition (kind · connector · dataset); repeats bump the count instead of flooding."
        action={
          <div className="flex rounded-lg border border-line p-0.5 text-sm">
            {(["open", "resolved", "all"] as const).map((s) => (
              <button key={s} onClick={() => setStatus(s)}
                className={`rounded-md px-3 py-1 capitalize ${status === s ? "bg-hover font-medium" : "text-mute"}`}>{s}</button>
            ))}
          </div>
        } />
      <ErrorNote error={error} />
      {!data ? <Empty>Loading…</Empty> : data.length === 0 ? (
        <Card><Empty>{status === "open" ? "No open alerts — everything is healthy." : "No alerts."}</Empty></Card>
      ) : (
        <div className="space-y-2">
          {data.map((a) => (
            <Card key={a.id} className={a.resolved_at ? "opacity-60" : a.severity === "critical" ? "border-bad/40" : ""}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={SEV_TONE[a.severity]}>{a.severity}</Badge>
                    <span className="font-mono text-xs font-semibold">{a.kind}</span>
                    {a.platform && <PlatformTag p={a.platform} />}
                    {a.dataset && <span className="font-mono text-xs text-mute">{a.dataset}</span>}
                    {a.occurrences > 1 && <Badge>×{a.occurrences}</Badge>}
                    {a.resolved_at && <Badge tone="good">resolved {ago(a.resolved_at, now)}</Badge>}
                  </div>
                  <p className="mt-1.5 text-sm">{a.message}</p>
                  <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-mute">
                    <span>raised {fmtTime(a.created_at)}</span>
                    <span>last seen {ago(a.last_seen_at, now)}</span>
                    {Object.entries(a.delivered ?? {}).map(([ch, st]) => (
                      <span key={ch}>{ch}: <span className={st === "sent" ? "text-good" : st.startsWith("error") ? "text-bad" : ""}>{st}</span></span>
                    ))}
                  </div>
                </div>
                <div className="flex shrink-0 gap-2">
                  {a.kind === "SESSION_EXPIRED" && !a.resolved_at && a.platform && (
                    <Link href={`/connectors/${a.platform}/reauth`}
                      className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white">Re-authenticate</Link>
                  )}
                  {!a.resolved_at && (
                    <Button onClick={() => resolve(a.id)} disabled={busy === a.id}>Resolve</Button>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
