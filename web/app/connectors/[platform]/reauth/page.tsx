"use client";

import Link from "next/link";
import { use, useState } from "react";
import { post, useLive, type ConnectorT, type RunT } from "@/lib/api";
import { Badge, Button, Card, PAGE_MOCK_URL, PageHeader, statusTone } from "@/components/ui";

type Start = { challenge_id: string; delivery: string; expires_in: number; message: string };
type Done = { status: string; session_expires_at: string; backfill: { task_id: string; since: string } };

export default function ReauthPage({ params }: { params: Promise<{ platform: string }> }) {
  const { platform } = use(params);
  const { data: conn } = useLive<ConnectorT>(`/connectors/${platform}`);
  const [start, setStart] = useState<Start | null>(null);
  const [otp, setOtp] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Done | null>(null);
  const { data: runs } = useLive<RunT[]>(done ? `/runs?platform=${platform}&mode=backfill&limit=8` : null);

  async function sendOtp() {
    setBusy(true); setErr(null);
    try { setStart(await post<Start>(`/reauth/${platform}/start`)); } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    if (!start) return;
    setBusy(true); setErr(null);
    try { setDone(await post<Done>(`/reauth/${platform}/otp`, { challenge_id: start.challenge_id, otp })); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  const since = done ? new Date(done.backfill.since).getTime() : 0;
  const backfillRuns = (runs ?? []).filter((r) => new Date(r.started_at).getTime() >= since - 60000);
  const finished = backfillRuns.filter((r) => r.status === "success").length;
  const complete = done && conn && !conn.open_intervention && finished >= 4;

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <PageHeader title={`Re-authenticate ${conn?.display_name ?? platform}`}
        sub="Q-REX never enters an OTP for you. You receive it on your phone and type it here." />

      <Card>
        <ol className="space-y-5 text-sm">
          <li>
            <div className="font-medium">1. Send a one-time password to the seller phone</div>
            <p className="mt-1 text-mute">
              Status: {conn ? <Badge tone={statusTone(conn.status)}>{conn.status}</Badge> : "…"}
              {conn?.open_intervention && <span> · waiting since {new Date(conn.open_intervention.requested_at).toLocaleTimeString()}</span>}
            </p>
            <div className="mt-2">
              <Button variant="primary" onClick={sendOtp} disabled={busy || !!done}>{start ? "Resend OTP" : "Send OTP"}</Button>
            </div>
            {start && <p className="mt-2 text-good">{start.message} Valid {Math.round(start.expires_in / 60)} min.</p>}
            <p className="mt-1 text-xs text-mute">
              Demo: the seller&apos;s phone is simulated at{" "}
              <a className="text-accent" href={`${PAGE_MOCK_URL}/dev/phone`} target="_blank" rel="noreferrer">mock-platform /dev/phone ↗</a>
            </p>
          </li>
          <li className={start ? "" : "opacity-50"}>
            <div className="font-medium">2. Enter the OTP</div>
            <form onSubmit={submit} className="mt-2 flex gap-2">
              <input inputMode="numeric" autoComplete="one-time-code" pattern="\d{4,8}" maxLength={8} required
                value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))} disabled={!start || !!done}
                placeholder="6-digit code"
                className="w-40 rounded-lg border border-line bg-bg px-3 py-1.5 font-mono tracking-widest outline-none focus:border-accent" />
              <Button type="submit" variant="primary" disabled={!start || busy || !!done || otp.length < 4}>Verify</Button>
            </form>
          </li>
          <li className={done ? "" : "opacity-50"}>
            <div className="font-medium">3. Resume and backfill the gap</div>
            {done ? (
              <div className="mt-2 space-y-2">
                <p className="text-good">Session restored. Backfilling from {new Date(done.backfill.since).toLocaleTimeString()}.</p>
                <div className="h-2 overflow-hidden rounded-full bg-hover">
                  <div className="h-full bg-good transition-all" style={{ width: `${(Math.min(finished, 4) / 4) * 100}%` }} />
                </div>
                <ul className="space-y-1 text-xs">
                  {backfillRuns.map((r) => (
                    <li key={r.id} className="flex justify-between">
                      <span>{r.dataset}</span>
                      <span><Badge tone={statusTone(r.status)}>{r.status}</Badge> {r.rows_upserted != null && `${r.rows_upserted} rows changed`}</span>
                    </li>
                  ))}
                </ul>
                {complete && <p className="font-medium text-good">Backfill complete. Intervention closed.</p>}
              </div>
            ) : <p className="mt-1 text-mute">Happens automatically after verification.</p>}
          </li>
        </ol>
        {err && <p className="mt-4 text-sm text-bad">{err}</p>}
      </Card>
      <Link href="/connectors" className="text-sm text-accent">← Back to connectors</Link>
    </div>
  );
}
