"use client";

import { useMemo } from "react";
import { post, useLive, useNow, type Freshness, type RunT } from "@/lib/api";
import { Icon } from "@/components/icons";
import { toast } from "@/components/toast";
import {
  DS_LABEL, Dot, PlatformTag, Status, TONE_VAR, ago, fmtTime, platformLabel, statusTone,
} from "@/components/ui";

type Ov = { connectors: { platform: string; display_name: string; status: string; freshness: Freshness[] }[] };
type Activity = {
  at: string; type: string; kind: string; tone: string; platform: string | null;
  dataset: string | null; title: string; detail: string | null;
};

/** Per source × dataset freshness with the last ~18 runs as a status strip. */
export function PipelineHealth() {
  const { data } = useLive<Ov>("/metrics/overview");
  const { data: runs } = useLive<RunT[]>("/runs?limit=320");
  const now = useNow(5000);
  const history = useMemo(() => {
    const m: Record<string, RunT[]> = {};
    for (const r of [...(runs ?? [])].reverse()) (m[`${r.platform}/${r.dataset}`] ??= []).push(r);
    return m;
  }, [runs]);

  if (!data) return <div className="skeleton h-[280px]" />;
  return (
    <section className="bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-5">
        <h2 className="text-[15px] font-semibold text-white">Pipeline health</h2>
        <div className="flex gap-4 text-[11px] text-mute">
          {[["success", "var(--good)"], ["retry", "var(--warn)"], ["failed / quarantined", "var(--bad)"]].map(([l, c]) => (
            <span key={l} className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: c }} />{l}</span>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2">
        {data.connectors.map((c, ci) => (
          <div key={c.platform} className={`p-5 ${ci ? "border-t-2 border-black/50 md:border-l-2 md:border-t-0" : ""}`}>
            <div className="mb-2 flex items-center justify-between">
              <PlatformTag p={c.platform} strong />
              <Status tone={statusTone(c.status)}>{c.status}</Status>
            </div>
            <div className="divide-y divide-white/5">
              {c.freshness.map((f) => {
                const tone = statusTone(f.state);
                const last = (history[`${c.platform}/${f.dataset}`] ?? []).slice(-18);
                return (
                  <div key={f.dataset} className="group flex items-center gap-3 py-2.5">
                    <Dot tone={tone} pulse={tone !== "good"} size={7} />
                    <div className="w-[120px] shrink-0">
                      <div className="text-[13px] text-white">{DS_LABEL[f.dataset]}</div>
                      <div className="text-[11.5px] text-faint">{ago(f.last_success_at, now)}</div>
                    </div>
                    <div className="flex min-w-0 flex-1 items-center justify-end gap-[3px] overflow-hidden">
                      {last.map((r) => (
                        <span key={r.id} className="h-4 w-[6px] shrink-0 rounded-[1px]"
                          title={`${fmtTime(r.started_at)} · ${r.status}${r.attempt > 1 ? ` (attempt ${r.attempt})` : ""}${r.error ? ` — ${r.error}` : ""}`}
                          style={{ background: TONE_VAR[statusTone(r.status)], opacity: r.status === "success" ? 0.6 : 1 }} />
                      ))}
                    </div>
                    <button disabled={c.status === "paused"} title="Sync now"
                      onClick={async () => {
                        try { await post(`/sync/${c.platform}/${f.dataset}`); toast(`${platformLabel(c.platform)} ${DS_LABEL[f.dataset].toLowerCase()} sync queued.`); }
                        catch (e) { toast((e as Error).message, "bad"); }
                      }}
                      className="grid h-7 w-7 place-items-center rounded-md text-faint opacity-0 transition hover:bg-white/10 hover:text-white group-hover:opacity-100 disabled:hidden">
                      <Icon name="refresh" size={14} />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Timeline of non-routine events: alerts, re-auths, retries, backfills. */
export function ActivityFeed({ limit = 30 }: { limit?: number }) {
  const { data: items } = useLive<Activity[]>(`/activity?limit=${limit}`);
  const now = useNow(5000);
  return (
    <section className="bg-surface">
      <h2 className="px-5 pt-5 text-[15px] font-semibold text-white">Activity</h2>
      {!items ? <div className="space-y-3 p-5">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-10" />)}</div>
        : !items.length ? <p className="p-5 text-sm text-mute">Nothing unusual yet — routine scheduled syncs are summarised away.</p> : (
        <ol className="max-h-[420px] overflow-y-auto px-5 py-2">
          {items.map((e, i) => (
            <li key={i} className="relative flex gap-3 py-2.5 pl-1">
              {i < items.length - 1 && <span className="absolute bottom-0 left-[4.5px] top-[24px] w-px bg-white/10" />}
              <span className="relative mt-[6px]"><Dot tone={statusTone(e.tone)} size={8} /></span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <div className="truncate text-[13px] text-white">{e.title}</div>
                  <div className="shrink-0 text-[11px] text-faint">{ago(e.at, now)}</div>
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11.5px] text-faint">
                  {e.platform && <PlatformTag p={e.platform} />}
                  {e.dataset && <span className="font-mono">{e.dataset}</span>}
                </div>
                {e.detail && <p className="mt-1 line-clamp-2 text-[11.5px] leading-relaxed text-mute">{e.detail}</p>}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
