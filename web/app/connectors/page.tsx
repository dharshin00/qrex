"use client";

import Link from "next/link";
import { useState } from "react";
import { API, api, post, useLive, useNow, type ConnectorT } from "@/lib/api";
import {
  Badge, Button, Card, Empty, ErrorNote, PLATFORM_COLOR, PageHeader, ago, fmtTime, statusTone,
} from "@/components/ui";

const DATASETS = ["orders", "inventory", "warehouse_stock", "sales"];

export default function ConnectorsPage() {
  const { data, error, reload } = useLive<ConnectorT[]>("/connectors");
  return (
    <div className="space-y-4">
      <PageHeader title="Connectors"
        sub="Status, session, consent, schedules and on-demand actions for each platform connector." />
      <ErrorNote error={error} />
      {!data ? <Empty>Loading…</Empty> : data.map((c) => <ConnectorCard key={c.id} c={c} reload={reload} />)}
    </div>
  );
}

function ConnectorCard({ c, reload }: { c: ConnectorT; reload: () => Promise<void> }) {
  const now = useNow(10000);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sched, setSched] = useState<Record<string, number>>(c.config.schedules ?? {});
  const [threshold, setThreshold] = useState(c.config.low_stock_threshold ?? 15);

  async function act(fn: () => Promise<unknown>, ok: string) {
    setBusy(true); setMsg(null);
    try { await fn(); setMsg(ok); await reload(); } catch (e) { setMsg(`Error: ${(e as Error).message}`); }
    finally { setBusy(false); }
  }

  async function upload(ev: React.FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    const f = new FormData(ev.currentTarget);
    const ds = f.get("dataset") as string;
    const body = new FormData();
    body.append("file", f.get("file") as File);
    await act(() => api(`/upload/${c.platform}/${ds}`, { method: "POST", body }), `Uploaded; ${ds} sync queued via MANUAL_UPLOAD.`);
  }

  const sessionLeft = c.session ? new Date(c.session.expires_at).getTime() - now : 0;

  return (
    <Card
      title={
        <span className="inline-flex items-center gap-2 text-base">
          <span className="h-3 w-3 rounded-full" style={{ background: PLATFORM_COLOR[c.platform] }} />
          {c.display_name}
        </span>
      }
      action={<div className="flex gap-2"><Badge tone={statusTone(c.status)}>{c.status}</Badge>{!c.enabled && <Badge>disabled</Badge>}</div>}>

      {c.status === "paused" && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-bad/40 bg-bad/10 px-3 py-2 text-sm">
          <span>Paused since {fmtTime(c.paused_at)} — waiting for the seller to re-authenticate. {c.open_intervention?.note}</span>
          <Link href={`/connectors/${c.platform}/reauth`} className="rounded-lg bg-bad px-3 py-1.5 font-medium text-white">Re-authenticate</Link>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-mute">Session</h3>
          {c.session ? (
            <div className="space-y-1 text-sm">
              <div>Status <Badge tone={statusTone(c.session.status === "active" ? "active" : "stale")}>{c.session.status}</Badge></div>
              <div className="text-mute">Issued {fmtTime(c.session.created_at)}</div>
              <div className="text-mute">
                {c.session.status === "active" && sessionLeft > 0
                  ? `Expires in ${Math.floor(sessionLeft / 3600000)}h ${Math.floor((sessionLeft % 3600000) / 60000)}m`
                  : `Expired ${fmtTime(c.session.expires_at)}`}
              </div>
              <div className="text-xs text-mute">Stored Fernet-encrypted; never logged.</div>
            </div>
          ) : <p className="text-sm text-mute">No session yet.</p>}
          <div className="mt-3">
            <Link href={`/connectors/${c.platform}/reauth`} className="text-sm text-accent">Re-authenticate now →</Link>
          </div>
        </div>

        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-mute">Datasets</h3>
          <table className="w-full text-sm">
            <tbody>
              {c.freshness.map((f) => (
                <tr key={f.dataset} className="border-b border-line last:border-0">
                  <td className="py-1.5">{f.dataset}</td>
                  <td className="py-1.5"><Badge tone={statusTone(f.state)}>{f.state}</Badge></td>
                  <td className="py-1.5 text-right text-xs text-mute">{ago(f.last_success_at, now)}</td>
                  <td className="py-1.5 text-right">
                    <Button variant="ghost" disabled={busy}
                      onClick={() => act(() => post(`/sync/${c.platform}/${f.dataset}`), `${f.dataset} sync queued.`)}>Sync</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-2">
            <Button disabled={busy} onClick={() => act(() => post(`/sync/${c.platform}/all`), "All datasets queued.")}>Sync all now</Button>
          </div>
        </div>

        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-mute">Schedule & thresholds</h3>
          <div className="space-y-1.5">
            {DATASETS.map((ds) => (
              <label key={ds} className="flex items-center justify-between gap-2 text-sm">
                <span>{ds}</span>
                <span className="flex items-center gap-1">
                  every
                  <input type="number" min={10} value={sched[ds] ?? 60}
                    onChange={(e) => setSched({ ...sched, [ds]: Number(e.target.value) })}
                    className="w-20 rounded-md border border-line bg-bg px-2 py-1 text-right" />s
                </span>
              </label>
            ))}
            <label className="flex items-center justify-between gap-2 text-sm">
              <span>low-stock threshold</span>
              <input type="number" min={0} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))}
                className="w-20 rounded-md border border-line bg-bg px-2 py-1 text-right" />
            </label>
          </div>
          <div className="mt-2">
            <Button variant="primary" disabled={busy}
              onClick={() => act(() => api(`/connectors/${c.platform}`, {
                method: "PATCH", headers: { "content-type": "application/json" },
                body: JSON.stringify({ schedules: sched, low_stock_threshold: threshold }),
              }), "Saved. New intervals apply from the next tick.")}>Save</Button>
          </div>
        </div>
      </div>

      <div className="mt-5 grid gap-4 border-t border-line pt-4 lg:grid-cols-2">
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-mute">Source-path ladder & consent</h3>
          <ol className="space-y-1 text-sm">
            {["OFFICIAL_API", "PORTAL_EXPORT", "EMAIL_INGEST", "MANUAL_UPLOAD"].map((p, i) => {
              const consent = c.consents.find((x) => x.source_path === p);
              return (
                <li key={p} className="flex items-start gap-2">
                  <span className="mt-0.5 w-4 text-xs text-mute">{i + 1}.</span>
                  <div>
                    <span className="font-mono text-xs">{p}</span>{" "}
                    {p === "OFFICIAL_API" ? <Badge>not available</Badge> : consent ? <Badge tone="good">consented</Badge> : <Badge tone="bad">no consent</Badge>}
                    {consent && <div className="text-xs text-mute">{consent.scope} — {consent.granted_by}, {fmtTime(consent.granted_at)}</div>}
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-mute">Manual upload (fallback)</h3>
          <form onSubmit={upload} className="flex flex-wrap items-center gap-2 text-sm">
            <select name="dataset" className="rounded-md border border-line bg-bg px-2 py-1.5">
              {DATASETS.map((d) => <option key={d}>{d}</option>)}
            </select>
            <input name="file" type="file" accept=".csv,text/csv" required className="text-xs" />
            <Button type="submit" disabled={busy}>Upload</Button>
          </form>
          <p className="mt-2 text-xs text-mute">
            Upload a report exported from the seller portal. It goes through the same validation, de-dup and load path.
            Email-ingest drop folder: <span className="font-mono">data/inbox/{c.platform}/&lt;dataset&gt;/</span>
          </p>
        </div>
      </div>

      {msg && <p className={`mt-3 text-sm ${msg.startsWith("Error") ? "text-bad" : "text-good"}`}>{msg}</p>}
      <p className="mt-2 text-[11px] text-mute">API: {API}</p>
    </Card>
  );
}
