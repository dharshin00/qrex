"use client";

import { useEffect, useRef, useState } from "react";
import { useLive, useNow, type RunT } from "@/lib/api";
import { ActivityFeed, PipelineHealth } from "@/components/pipeline";
import {
  Card, DS_LABEL, Empty, ErrorNote, Mini, PageHeader, PlatformTag, Select, SkeletonPage, Status, ago, fmtTime,
  statusTone,
} from "@/components/ui";

const opt = (xs: string[], all: string) => [{ value: "", label: all }, ...xs.map((x) => ({ value: x, label: x.replace("_", " ") }))];

export default function RunsPage() {
  const [platform, setPlatform] = useState("");
  const [dataset, setDataset] = useState("");
  const [status, setStatus] = useState("");
  const [mode, setMode] = useState("");
  const [limit, setLimit] = useState(50);
  const qs = new URLSearchParams(Object.entries({ platform, dataset, status, mode, limit: String(limit) }).filter(([, v]) => v)).toString();
  const { data, error } = useLive<RunT[]>(`/runs?${qs}`);
  const now = useNow(5000);

  // remember which run ids we've already shown, so only new arrivals animate
  const seen = useRef<Set<number> | null>(null);
  const [fresh, setFresh] = useState<Set<number>>(new Set());
  useEffect(() => {
    if (!data) return;
    if (seen.current === null) { seen.current = new Set(data.map((r) => r.id)); return; }
    const added = data.filter((r) => !seen.current!.has(r.id)).map((r) => r.id);
    added.forEach((id) => seen.current!.add(id));
    if (added.length) setFresh(new Set(added));
  }, [data]);

  if (!data) return error ? <ErrorNote error={error} /> : <SkeletonPage />;

  const done = data.filter((r) => r.status !== "running");
  const ok = done.filter((r) => r.status === "success").length;
  const rate = done.length ? Math.round((ok / done.length) * 100) : 100;
  const retries = data.filter((r) => r.attempt > 1).length;
  const quarantined = data.filter((r) => r.status === "quarantined").length;
  const durations = data.map((r) => r.duration_ms).filter((d): d is number => d != null).sort((a, b) => a - b);
  const p50 = durations.length ? durations[Math.floor(durations.length / 2)] : 0;

  return (
    <div>
      <PageHeader kicker="Sync runs" title="Every pull, every attempt."
        sub="Status, the source path that served it, and how many rows actually changed — re-runs changing 0 rows is idempotency at work." />
      <ErrorNote error={error} />

      <div className="mb-2.5 grid gap-2.5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <PipelineHealth />
        <ActivityFeed />
      </div>

      <div className="mb-2.5 grid grid-cols-2 gap-2.5 md:grid-cols-4">
        <Mini label="Success rate" value={`${rate}%`} tone={rate >= 95 ? "good" : rate >= 80 ? "warn" : "bad"} note={`of the last ${done.length} runs shown`} />
        <Mini label="Retried" value={retries} note="attempt > 1 (backoff + jitter)" tone={retries ? "warn" : undefined} />
        <Mini label="Quarantined" value={quarantined} note="blocked before the clean layer" tone={quarantined ? "bad" : undefined} />
        <Mini label="Median duration" value={`${p50} ms`} note="per pull, end to end" />
      </div>

      <Card pad={false} title={`${data.length} runs`}
        action={
          <div className="flex flex-wrap gap-2">
            <Select label="platform" value={platform} onChange={setPlatform} options={opt(["blinkit", "instamart"], "All platforms")} />
            <Select label="dataset" value={dataset} onChange={setDataset} options={opt(["orders", "inventory", "warehouse_stock", "sales"], "All datasets")} />
            <Select label="status" value={status} onChange={setStatus} options={opt(["success", "retrying", "failed", "quarantined", "paused", "running"], "All statuses")} />
            <Select label="mode" value={mode} onChange={setMode} options={opt(["scheduled", "manual", "backfill"], "All modes")} />
          </div>
        }>
        {data.length === 0 ? <Empty icon="runs" title="No runs match">Clear a filter to see more.</Empty> : (
          <div className="max-h-[600px] overflow-auto">
            <table className="w-full min-w-[1100px] text-[14px]">
              <thead className="sticky top-0 z-[1] border-b border-line bg-surface">
                <tr>
                  {["Run", "When", "Source", "Dataset", "Status", "Mode", "Path", "Rows in", "Changed", "Took", ""].map((h, i) => (
                    <th key={i} className={`label whitespace-nowrap px-3 py-3 font-normal text-faint first:pl-5 ${["Rows in", "Changed", "Took"].includes(h) ? "text-right" : "text-left"}`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.map((r) => (
                  <tr key={r.id} className={`align-top hover:bg-hover/60 ${fresh.has(r.id) ? "rise bg-accent/5" : ""}`}>
                    <td className="py-2.5 pl-5 pr-3 font-mono text-[12px] text-faint">#{r.id}</td>
                    <td className="whitespace-nowrap px-3 py-2.5">
                      <div className="text-ink">{ago(r.started_at, now)}</div>
                      <div className="text-[12px] text-faint">{fmtTime(r.started_at)}</div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5"><PlatformTag p={r.platform} /></td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-ink">{DS_LABEL[r.dataset] ?? r.dataset}</td>
                    <td className="px-3 py-2.5">
                      <Status tone={statusTone(r.status)} pulse={r.status === "running" || r.status === "retrying"}>{r.status}</Status>
                      {r.attempt > 1 && <div className="mt-0.5 text-[12px] text-faint">attempt {r.attempt}</div>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-[13px] text-mute">{r.mode}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 font-mono text-[12px] text-mute">{r.source_path?.replace("_", " ").toLowerCase() ?? "—"}</td>
                    <td className="tnum px-3 py-2.5 text-right text-mute">{r.rows_in ?? "—"}</td>
                    <td className="tnum px-3 py-2.5 text-right" style={{ color: r.rows_upserted ? "var(--ink)" : "var(--faint)" }}>{r.rows_upserted ?? "—"}</td>
                    <td className="tnum whitespace-nowrap px-3 py-2.5 text-right text-[13px] text-faint">{r.duration_ms != null ? `${r.duration_ms} ms` : "—"}</td>
                    <td className="max-w-[320px] px-5 py-2.5 text-[12px] leading-relaxed" style={{ color: "var(--bad)" }}>
                      {r.error && <span className="line-clamp-2" title={r.error}>{r.error}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data.length >= limit && limit < 500 && (
              <div className="flex justify-center border-t border-line p-4">
                <button onClick={() => setLimit((l) => Math.min(l + 50, 500))} className="label text-faint hover:text-accent">
                  Show 50 more
                </button>
              </div>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
