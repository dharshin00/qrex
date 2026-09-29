"use client";

import Link from "next/link";
import { useState } from "react";
import { post, useLive, useNow, type AlertT } from "@/lib/api";
import { Icon, type IconName } from "@/components/icons";
import { toast } from "@/components/toast";
import {
  Button, Card, Empty, ErrorNote, PageHeader, PlatformTag, Segmented, SkeletonPage, Status, TONE_VAR, ago,
  fmtTime, statusTone,
} from "@/components/ui";

const KIND_ICON: Record<string, IconName> = {
  SESSION_EXPIRED: "key", SCHEMA_DRIFT: "layers", PULL_FAILED: "x", PARTIAL_PULL: "alert",
  STALE_SOURCE: "clock", STOCK_OUT: "warehouse", LOW_STOCK: "warehouse",
};
const human = (k: string) => k.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

export default function AlertsPage() {
  const [status, setStatus] = useState<"open" | "resolved" | "all">("open");
  const [kind, setKind] = useState<string>("");
  const { data, error, reload } = useLive<AlertT[]>(`/alerts?status=${status}`);
  const [busy, setBusy] = useState<number | null>(null);
  const now = useNow(10000);

  async function resolve(a: AlertT) {
    setBusy(a.id);
    try { await post(`/alerts/${a.id}/resolve`); toast(`${human(a.kind)} resolved.`); await reload(); }
    catch (e) { toast((e as Error).message, "bad"); }
    finally { setBusy(null); }
  }

  if (!data) return error ? <ErrorNote error={error} /> : <SkeletonPage />;
  const kinds = Array.from(new Set(data.map((a) => a.kind))).sort();
  const shown = data.filter((a) => !kind || a.kind === kind);
  const crit = data.filter((a) => !a.resolved_at && a.severity === "critical").length;

  return (
    <div>
      <PageHeader kicker="Alerts"
        title={status === "open" ? (data.length ? `${data.length} open alert${data.length > 1 ? "s" : ""}.` : "All clear.") : "Alert history."}
        sub="One open alert per condition (kind · source · dataset). Repeats bump a counter instead of flooding your inbox, and alerts resolve themselves when the condition clears."
        action={<Segmented value={status} onChange={(v) => { setStatus(v); setKind(""); }}
          options={[{ value: "open", label: "Open" }, { value: "resolved", label: "Resolved" }, { value: "all", label: "All" }]} />} />
      <ErrorNote error={error} />

      {kinds.length > 1 && (
        <div className="mb-5 flex flex-wrap gap-2">
          {["", ...kinds].map((k) => (
            <button key={k || "all"} onClick={() => setKind(k)}
              className={`label h-7 border px-3 transition ${kind === k ? "border-ink bg-ink text-bg" : "border-line-strong text-mute hover:text-ink"}`}>
              {k ? human(k) : "Every kind"} <span className="opacity-60">{k ? data.filter((a) => a.kind === k).length : data.length}</span>
            </button>
          ))}
        </div>
      )}

      {shown.length === 0 ? (
        <Card><Empty icon="shield" title={status === "open" ? "No open alerts" : "No alerts yet"}>
          {status === "open" ? "Every source is healthy. Inject a fault from the chaos panel to see Q-REX react." : "Alerts will appear here as conditions are detected."}
        </Empty></Card>
      ) : (
        <div className="space-y-2">
          {crit > 0 && status !== "resolved" && (
            <div className="label mb-1 text-bad">{crit} critical</div>
          )}
          {shown.map((a) => {
            const tone = a.resolved_at ? "good" : statusTone(a.severity);
            return (
              <article key={a.id} className={`rise relative flex gap-4 border border-line bg-surface p-4 pl-5 ${a.resolved_at ? "opacity-70" : ""}`}>
                <span className="absolute inset-y-0 left-0 w-[3px]" style={{ background: TONE_VAR[tone] }} />
                <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center border border-line" style={{ color: TONE_VAR[tone] }}>
                  <Icon name={KIND_ICON[a.kind] ?? "bell"} size={17} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="font-display text-[16px] font-semibold text-ink">{human(a.kind)}</span>
                    {a.platform && <PlatformTag p={a.platform} />}
                    {a.dataset && <span className="font-mono text-[12px] text-faint">{a.dataset}</span>}
                    {a.occurrences > 1 && <span className="label text-faint">×{a.occurrences}</span>}
                    {a.resolved_at ? <Status tone="good">resolved {ago(a.resolved_at, now)}</Status>
                      : <Status tone={statusTone(a.severity)} pulse={a.severity === "critical"}>{a.severity}</Status>}
                  </div>
                  <p className="mt-1.5 text-[14px] leading-relaxed text-mute">{a.message}</p>
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-faint">
                    <span>raised {fmtTime(a.created_at, true)}</span>
                    <span>last seen {ago(a.last_seen_at, now)}</span>
                    {Object.entries(a.delivered ?? {}).map(([ch, st]) => (
                      <span key={ch} className="inline-flex items-center gap-1">
                        {ch}
                        <span style={{ color: st === "sent" ? "var(--good)" : st.startsWith("error") ? "var(--bad)" : "var(--faint)" }}>
                          {st === "sent" ? "✓" : st}
                        </span>
                      </span>
                    ))}
                  </div>
                </div>
                {!a.resolved_at && (
                  <div className="flex shrink-0 flex-col items-end gap-2 sm:flex-row sm:items-start">
                    {a.kind === "SESSION_EXPIRED" && a.platform && (
                      <Link href={`/connectors/${a.platform}/reauth`}
                        className="inline-flex h-9 items-center gap-2 bg-accent px-3.5 text-sm font-medium text-on-accent hover:opacity-90">
                        <Icon name="key" size={15} /> Re-authenticate
                      </Link>
                    )}
                    <Button onClick={() => resolve(a)} disabled={busy === a.id} icon="check">Resolve</Button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
