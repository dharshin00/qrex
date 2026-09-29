"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { api, post, useLive, useNow, type ConnectorT } from "@/lib/api";
import { Icon } from "@/components/icons";
import { toast } from "@/components/toast";
import {
  Button, DS_LABEL, ErrorNote, PLATFORM_VAR, PageHeader, SkeletonPage, Status, TONE_VAR, ago, fmtTime,
  statusTone,
} from "@/components/ui";

const DATASETS = ["orders", "inventory", "warehouse_stock", "sales"];
const LADDER = [
  { path: "OFFICIAL_API", label: "Official API", note: "Preferred when a platform offers one" },
  { path: "PORTAL_EXPORT", label: "Portal export", note: "Seller’s own reports, consented" },
  { path: "EMAIL_INGEST", label: "Report email", note: "Scheduled reports, no session" },
  { path: "MANUAL_UPLOAD", label: "Manual upload", note: "Last resort, same checks" },
];

export default function ConnectorsPage() {
  const { data, error, reload } = useLive<ConnectorT[]>("/connectors");
  if (!data) return error ? <ErrorNote error={error} /> : <SkeletonPage />;
  const paused = data.filter((c) => c.status === "paused").length;
  return (
    <div>
      <PageHeader kicker="Connectors"
        title={paused ? `${paused} connector${paused > 1 ? "s" : ""} waiting on you.` : "Both connectors are live."}
        sub="Sessions, consent, schedules and on-demand actions. Every rung of the source ladder needs logged seller consent." />
      <ErrorNote error={error} />
      <div className="space-y-8">
        {data.map((c) => <ConnectorPanel key={c.id} c={c} reload={reload} />)}
      </div>
    </div>
  );
}

function ConnectorPanel({ c, reload }: { c: ConnectorT; reload: () => Promise<void> }) {
  const now = useNow(5000);
  const [busy, setBusy] = useState(false);
  const [sched, setSched] = useState<Record<string, number>>(c.config.schedules ?? {});
  const [threshold, setThreshold] = useState(c.config.low_stock_threshold ?? 15);
  const dirty = JSON.stringify(sched) !== JSON.stringify(c.config.schedules ?? {}) || threshold !== (c.config.low_stock_threshold ?? 15);

  async function act(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    try { await fn(); toast(ok); await reload(); } catch (e) { toast((e as Error).message, "bad"); }
    finally { setBusy(false); }
  }

  const s = c.session;
  const left = s ? new Date(s.expires_at).getTime() - now : 0;
  const total = s ? new Date(s.expires_at).getTime() - new Date(s.created_at).getTime() : 1;
  const sessionActive = s?.status === "active" && left > 0;
  const paths = c.freshness.map((f) => f.last_source_path).filter(Boolean) as string[];
  const winning = paths.sort((a, b) => paths.filter((x) => x === b).length - paths.filter((x) => x === a).length)[0];

  return (
    <section className="border border-line bg-surface">
      {/* header */}
      <header className="flex flex-wrap items-center gap-4 border-b border-line px-6 py-5">
        <span className="h-10 w-1.5" style={{ background: PLATFORM_VAR[c.platform] }} />
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-[24px] font-extrabold leading-none tracking-[-0.02em] text-ink">{c.display_name}</h2>
          <div className="mt-2 flex flex-wrap items-center gap-4">
            <Status tone={statusTone(c.status)} pulse={c.status === "paused"}>{c.status}</Status>
            <span className="label text-faint">seller · {c.config.seller_id ?? "—"}</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button icon="refresh" disabled={busy || c.status === "paused"}
            onClick={() => act(() => post(`/sync/${c.platform}/all`), `${c.display_name}: all datasets queued.`)}>Sync all</Button>
          <Link href={`/connectors/${c.platform}/reauth`}
            className={`inline-flex h-9 items-center gap-2 px-3.5 text-sm font-medium transition ${c.status === "paused" ? "bg-accent text-on-accent hover:opacity-90" : "border border-line-strong text-ink hover:bg-hover"}`}>
            <Icon name="key" size={16} /> Re-authenticate
          </Link>
        </div>
      </header>

      {c.status === "paused" && (
        <div className="flex items-center gap-3 border-b border-line bg-bad/10 px-6 py-3 text-[14px] text-ink">
          <Icon name="pause" className="text-bad" />
          Paused since {fmtTime(c.paused_at)}. {c.open_intervention?.note ? `Reason: ${c.open_intervention.note}.` : ""} Data stays visible, marked stale.
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[300px_minmax(0,1fr)_300px]">
        {/* session */}
        <div className="border-b border-line p-6 lg:border-b-0 lg:border-r">
          <div className="label mb-4 text-faint">Seller session</div>
          {s ? (
            <>
              <div className="font-display text-[30px] font-extrabold leading-none tracking-[-0.02em] tnum"
                style={{ color: sessionActive ? "var(--ink)" : "var(--bad)" }}>
                {sessionActive ? `${Math.floor(left / 3600000)}h ${Math.floor((left % 3600000) / 60000)}m` : "Expired"}
              </div>
              <div className="mt-1 text-[13px] text-mute">{sessionActive ? "until the session expires" : `at ${fmtTime(s.expires_at, true)}`}</div>
              <div className="mt-4 h-1.5 bg-surface-2">
                <div className="h-full transition-all" style={{ width: `${sessionActive ? Math.max(2, (left / total) * 100) : 0}%`,
                  background: left / total < 0.15 ? "var(--warn)" : "var(--good)" }} />
              </div>
              <dl className="mt-5 space-y-1.5 text-[13px]">
                <div className="flex justify-between"><dt className="text-faint">Issued</dt><dd className="text-mute">{fmtTime(s.created_at, true)}</dd></div>
                <div className="flex justify-between"><dt className="text-faint">Storage</dt><dd className="text-mute">Fernet-encrypted</dd></div>
                <div className="flex justify-between"><dt className="text-faint">In logs</dt><dd className="text-mute">never</dd></div>
              </dl>
            </>
          ) : <p className="text-sm text-mute">No session yet — re-authenticate to connect.</p>}
        </div>

        {/* datasets */}
        <div className="border-b border-line p-6 lg:border-b-0 lg:border-r">
          <div className="label mb-2 text-faint">Datasets · freshness vs SLA</div>
          <div className="divide-y divide-line">
            {c.freshness.map((f) => {
              const pct = f.age_seconds == null ? 100 : Math.min(100, (f.age_seconds / f.sla_seconds) * 100);
              const tone = statusTone(f.state);
              return (
                <div key={f.dataset} className="group flex items-center gap-4 py-3">
                  <div className="w-[120px] shrink-0 sm:w-[140px]">
                    <div className="text-[14px] text-ink">{DS_LABEL[f.dataset]}</div>
                    <div className="text-[12px] text-faint">every {f.interval_seconds}s · SLA {Math.round(f.sla_seconds / 60)}m</div>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="h-1.5 bg-surface-2">
                      <div className="h-full" style={{ width: `${Math.max(pct, 2)}%`, background: TONE_VAR[tone] }} />
                    </div>
                    <div className="mt-1.5 flex justify-between text-[12px]">
                      <span className="text-mute">synced {ago(f.last_success_at, now)}</span>
                      <Status tone={tone}>{f.state}</Status>
                    </div>
                  </div>
                  <Button size="sm" variant="ghost" icon="refresh" disabled={busy || c.status === "paused"}
                    onClick={() => act(() => post(`/sync/${c.platform}/${f.dataset}`), `${DS_LABEL[f.dataset]} sync queued.`)}>Sync</Button>
                </div>
              );
            })}
          </div>
        </div>

        {/* schedule */}
        <div className="p-6">
          <div className="label mb-4 text-faint">Schedule & thresholds</div>
          <div className="space-y-2.5">
            {DATASETS.map((ds) => (
              <label key={ds} className="flex items-center justify-between gap-3 text-[14px] text-mute">
                {DS_LABEL[ds]}
                <span className="flex items-center border border-line-strong focus-within:border-accent">
                  <input type="number" min={10} value={sched[ds] ?? 60}
                    onChange={(e) => setSched({ ...sched, [ds]: Number(e.target.value) })}
                    className="tnum h-8 w-16 bg-transparent px-2 text-right text-ink outline-none" />
                  <span className="pr-2 text-[12px] text-faint">sec</span>
                </span>
              </label>
            ))}
            <label className="flex items-center justify-between gap-3 border-t border-line pt-3 text-[14px] text-mute">
              Low-stock below
              <span className="flex items-center border border-line-strong focus-within:border-accent">
                <input type="number" min={0} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))}
                  className="tnum h-8 w-16 bg-transparent px-2 text-right text-ink outline-none" />
                <span className="pr-2 text-[12px] text-faint">units</span>
              </span>
            </label>
          </div>
          <div className="mt-4">
            <Button variant="primary" disabled={busy || !dirty}
              onClick={() => act(() => api(`/connectors/${c.platform}`, {
                method: "PATCH", headers: { "content-type": "application/json" },
                body: JSON.stringify({ schedules: sched, low_stock_threshold: threshold }),
              }), "Saved — new intervals apply on the next scheduler tick.")}>
              {dirty ? "Save changes" : "Saved"}
            </Button>
          </div>
        </div>
      </div>

      {/* ladder + upload */}
      <div className="grid grid-cols-1 border-t border-line lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="border-b border-line p-6 lg:border-b-0 lg:border-r">
          <div className="label mb-5 text-faint">Source-path ladder · first rung that works wins</div>
          <ol className="grid gap-4 sm:grid-cols-4 sm:gap-0">
            {LADDER.map((r, i) => {
              const consent = c.consents.find((x) => x.source_path === r.path);
              const available = r.path !== "OFFICIAL_API" && !!consent;
              const isWinner = winning === r.path;
              return (
                <li key={r.path} className="relative sm:pr-5">
                  {i < LADDER.length - 1 && <span className="absolute left-[15px] right-0 top-[15px] hidden h-px bg-line-strong sm:block" />}
                  <span className="relative grid h-[31px] w-[31px] place-items-center border font-mono text-[13px]"
                    style={{
                      background: isWinner ? "var(--accent)" : "var(--surface)",
                      color: isWinner ? "var(--on-accent)" : available ? "var(--ink)" : "var(--faint)",
                      borderColor: isWinner ? "var(--accent)" : "var(--line-strong)",
                    }}>{i + 1}</span>
                  <div className="mt-3 text-[14px] font-medium" style={{ color: available ? "var(--ink)" : "var(--faint)" }}>{r.label}</div>
                  <div className="mt-0.5 text-[12px] text-faint">{r.note}</div>
                  <div className="mt-2">
                    {isWinner ? <Status tone="info">serving now</Status>
                      : r.path === "OFFICIAL_API" ? <Status tone="mute">not available</Status>
                      : consent ? <Status tone="good">consented</Status> : <Status tone="bad">no consent</Status>}
                  </div>
                  {consent && <div className="mt-1 text-[11px] text-faint" title={consent.scope}>by {consent.granted_by.split(" (")[0]}</div>}
                </li>
              );
            })}
          </ol>
        </div>
        <UploadZone platform={c.platform} onDone={reload} />
      </div>
    </section>
  );
}

function UploadZone({ platform, onDone }: { platform: string; onDone: () => Promise<void> }) {
  const [ds, setDs] = useState("orders");
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  async function send(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    try {
      const body = new FormData();
      body.append("file", file);
      await api(`/upload/${platform}/${ds}`, { method: "POST", body });
      toast(`${file.name} uploaded — ${DS_LABEL[ds].toLowerCase()} sync queued via manual upload.`);
      await onDone();
    } catch (e) { toast((e as Error).message, "bad"); }
    finally { setBusy(false); if (input.current) input.current.value = ""; }
  }

  return (
    <div className="p-6">
      <div className="mb-3 flex items-center justify-between">
        <div className="label text-faint">Manual upload</div>
        <select value={ds} onChange={(e) => setDs(e.target.value)} aria-label="dataset"
          className="h-7 border border-line-strong bg-surface px-2 text-[12px] text-ink outline-none">
          {DATASETS.map((d) => <option key={d} value={d}>{DS_LABEL[d]}</option>)}
        </select>
      </div>
      <button type="button" disabled={busy}
        onClick={() => input.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); send(e.dataTransfer.files[0]); }}
        className={`flex w-full flex-col items-center justify-center gap-2 border border-dashed px-4 py-7 text-center transition ${
          over ? "border-accent bg-accent/10" : "border-line-strong hover:border-accent/60 hover:bg-hover/50"}`}>
        <Icon name="upload" size={20} className="text-faint" />
        <span className="text-[14px] text-ink">{busy ? "Uploading…" : "Drop a report CSV or click to choose"}</span>
        <span className="text-[12px] text-faint">Same validation, de-dup and load path as every other source</span>
      </button>
      <input ref={input} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => send(e.target.files?.[0])} />
    </div>
  );
}
