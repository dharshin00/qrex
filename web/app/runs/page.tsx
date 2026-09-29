"use client";

import { useState } from "react";
import { useLive, type RunT } from "@/lib/api";
import { Badge, Card, Empty, ErrorNote, PageHeader, PlatformTag, fmtTime, statusTone } from "@/components/ui";

const STATUSES = ["", "success", "retrying", "failed", "quarantined", "paused", "running"];
const MODES = ["", "scheduled", "manual", "backfill"];
const DATASETS = ["", "orders", "inventory", "warehouse_stock", "sales"];

function Select({ value, onChange, options, label }: {
  value: string; onChange: (v: string) => void; options: string[]; label: string;
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}
      className="rounded-lg border border-line bg-bg px-2 py-1.5 text-sm">
      {options.map((o) => <option key={o} value={o}>{o || `all ${label}`}</option>)}
    </select>
  );
}

export default function RunsPage() {
  const [platform, setPlatform] = useState("");
  const [dataset, setDataset] = useState("");
  const [status, setStatus] = useState("");
  const [mode, setMode] = useState("");
  const qs = new URLSearchParams(Object.entries({ platform, dataset, status, mode, limit: "200" })
    .filter(([, v]) => v)).toString();
  const { data, error } = useLive<RunT[]>(`/runs?${qs}`);

  return (
    <div className="space-y-4">
      <PageHeader title="Sync runs"
        sub="Every attempt of every pull: status, winning source path, rows in vs rows actually changed." />
      <ErrorNote error={error} />
      <Card
        title={data ? `${data.length} runs` : "Runs"}
        action={
          <div className="flex flex-wrap gap-2">
            <Select value={platform} onChange={setPlatform} options={["", "blinkit", "instamart"]} label="platforms" />
            <Select value={dataset} onChange={setDataset} options={DATASETS} label="datasets" />
            <Select value={status} onChange={setStatus} options={STATUSES} label="statuses" />
            <Select value={mode} onChange={setMode} options={MODES} label="modes" />
          </div>
        }>
        {!data ? <Empty>Loading…</Empty> : data.length === 0 ? <Empty>No runs match these filters.</Empty> : (
          <div className="-mx-4 overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead className="text-left text-xs text-mute">
                <tr className="border-b border-line">
                  {["#", "Started", "Platform", "Dataset", "Mode", "Attempt", "Status", "Source path", "Rows in", "Changed", "Duration", "Error"]
                    .map((h) => <th key={h} className="px-3 py-2 font-medium first:pl-4">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {data.map((r) => (
                  <tr key={r.id} className="border-b border-line last:border-0 hover:bg-hover">
                    <td className="py-1.5 pl-4 pr-3 font-mono text-xs text-mute">{r.id}</td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-xs">{fmtTime(r.started_at)}</td>
                    <td className="px-3 py-1.5"><PlatformTag p={r.platform} /></td>
                    <td className="px-3 py-1.5">{r.dataset}</td>
                    <td className="px-3 py-1.5 text-xs text-mute">{r.mode}</td>
                    <td className="px-3 py-1.5 text-center">{r.attempt}</td>
                    <td className="px-3 py-1.5"><Badge tone={statusTone(r.status)}>{r.status}</Badge></td>
                    <td className="px-3 py-1.5 font-mono text-xs">{r.source_path ?? "—"}</td>
                    <td className="px-3 py-1.5 text-right">{r.rows_in ?? "—"}</td>
                    <td className="px-3 py-1.5 text-right">{r.rows_upserted ?? "—"}</td>
                    <td className="px-3 py-1.5 text-right text-xs">{r.duration_ms != null ? `${r.duration_ms} ms` : "—"}</td>
                    <td className="max-w-[280px] truncate px-3 py-1.5 text-xs text-bad" title={r.error ?? ""}>{r.error}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
