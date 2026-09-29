"use client";

import Link from "next/link";
import { use, useRef, useState } from "react";
import { post, useLive, type ConnectorT, type RunT } from "@/lib/api";
import { Icon } from "@/components/icons";
import { toast } from "@/components/toast";
import { Button, DS_LABEL, PAGE_MOCK_URL, PLATFORM_VAR, Status, statusTone } from "@/components/ui";

type Start = { challenge_id: string; delivery: string; expires_in: number; message: string };
type Done = { status: string; session_expires_at: string; backfill: { task_id: string; since: string } };

export default function ReauthPage({ params }: { params: Promise<{ platform: string }> }) {
  const { platform } = use(params);
  const { data: conn } = useLive<ConnectorT>(`/connectors/${platform}`);
  const [start, setStart] = useState<Start | null>(null);
  const [digits, setDigits] = useState<string[]>(Array(6).fill(""));
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Done | null>(null);
  const boxes = useRef<(HTMLInputElement | null)[]>([]);
  const { data: runs } = useLive<RunT[]>(done ? `/runs?platform=${platform}&mode=backfill&limit=8` : null);

  const otp = digits.join("");
  const step = done ? 3 : start ? 2 : 1;

  async function sendOtp() {
    setBusy(true); setErr(null);
    try {
      setStart(await post<Start>(`/reauth/${platform}/start`));
      setDigits(Array(6).fill(""));
      setTimeout(() => boxes.current[0]?.focus(), 50);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  async function verify(code = otp) {
    if (!start || code.length < 6) return;
    setBusy(true); setErr(null);
    try {
      setDone(await post<Done>(`/reauth/${platform}/otp`, { challenge_id: start.challenge_id, otp: code }));
      toast("Session restored — backfilling the gap.");
    } catch (e) {
      setErr((e as Error).message === "OTP rejected" ? "That code didn’t match. Check the latest SMS and try again." : (e as Error).message);
      setDigits(Array(6).fill(""));
      boxes.current[0]?.focus();
    } finally { setBusy(false); }
  }

  function setDigit(i: number, v: string) {
    const clean = v.replace(/\D/g, "");
    if (clean.length > 1) { // paste
      const next = clean.slice(0, 6).split("");
      const filled = [...next, ...Array(6 - next.length).fill("")];
      setDigits(filled);
      boxes.current[Math.min(next.length, 5)]?.focus();
      if (next.length === 6) verify(next.join(""));
      return;
    }
    const next = [...digits];
    next[i] = clean;
    setDigits(next);
    if (clean && i < 5) boxes.current[i + 1]?.focus();
    if (next.every(Boolean)) verify(next.join(""));
  }

  const since = done ? new Date(done.backfill.since).getTime() : 0;
  const bf = (runs ?? []).filter((r) => new Date(r.started_at).getTime() >= since - 60000);
  const finished = new Set(bf.filter((r) => r.status === "success").map((r) => r.dataset)).size;
  const complete = done && conn && !conn.open_intervention && finished >= 4;

  return (
    <div className="mx-auto max-w-[640px]">
      <Link href="/connectors" className="label inline-flex items-center gap-2 text-faint hover:text-accent">← Connectors</Link>

      <div className="mt-6 flex items-center gap-3">
        <span className="h-9 w-1.5" style={{ background: PLATFORM_VAR[platform] }} />
        <div>
          <div className="kicker">Re-authenticate</div>
          <h1 className="mt-2 font-display text-[36px] font-extrabold leading-none tracking-[-0.03em] text-ink">
            {conn?.display_name ?? platform}
          </h1>
        </div>
      </div>
      <p className="mt-4 text-[15px] text-mute">
        Q-REX never enters an OTP for you. The platform texts it to the seller’s phone; you type it here, then Q-REX resumes and backfills everything it missed.
      </p>
      {conn && (
        <div className="mt-4 flex flex-wrap items-center gap-4 text-[13px]">
          <Status tone={statusTone(conn.status)} pulse={conn.status === "paused"}>{conn.status}</Status>
          {conn.open_intervention && <span className="text-faint">waiting since {new Date(conn.open_intervention.requested_at).toLocaleTimeString()}</span>}
        </div>
      )}

      <ol className="mt-8 border border-line bg-surface">
        {/* step 1 */}
        <Step n={1} active={step === 1} done={step > 1} title="Send a code to the seller’s phone">
          <div className="flex flex-wrap items-center gap-3">
            <Button variant={step === 1 ? "accent" : "default"} icon="phone" onClick={sendOtp} disabled={busy || !!done}>
              {start ? "Send a new code" : "Send code"}
            </Button>
            {start && <span className="text-[13px] text-good">Sent by {start.delivery.toUpperCase()} · valid {Math.round(start.expires_in / 60)} min</span>}
          </div>
          <p className="mt-3 text-[12px] text-faint">
            Demo: the seller’s phone is simulated at{" "}
            <a className="text-accent hover:underline" href={`${PAGE_MOCK_URL}/dev/phone`} target="_blank" rel="noreferrer">mock-platform /dev/phone ↗</a>
          </p>
        </Step>

        {/* step 2 */}
        <Step n={2} active={step === 2} done={step > 2} title="Enter the 6-digit code">
          <form onSubmit={(e) => { e.preventDefault(); verify(); }} className="flex flex-wrap items-center gap-4">
            <div className="flex gap-2" onPaste={(e) => { e.preventDefault(); setDigit(0, e.clipboardData.getData("text")); }}>
              {digits.map((d, i) => (
                <input key={i} ref={(el) => { boxes.current[i] = el; }} value={d} inputMode="numeric"
                  autoComplete={i === 0 ? "one-time-code" : "off"} aria-label={`Digit ${i + 1}`}
                  disabled={!start || !!done || busy} maxLength={6}
                  onChange={(e) => setDigit(i, e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Backspace" && !d && i) boxes.current[i - 1]?.focus(); }}
                  className="h-14 w-11 border border-line-strong bg-bg text-center font-mono text-[24px] text-ink outline-none transition focus:border-accent disabled:opacity-40" />
              ))}
            </div>
            <Button type="submit" variant="primary" disabled={!start || busy || !!done || otp.length < 6}>Verify</Button>
          </form>
          {err && <p className="mt-3 flex items-center gap-2 text-[13px] text-bad"><Icon name="alert" size={14} />{err}</p>}
        </Step>

        {/* step 3 */}
        <Step n={3} active={step === 3} done={!!complete} title="Resume & backfill the gap" last>
          {done ? (
            <div>
              <p className="text-[14px] text-mute">
                Session restored. Re-pulling everything since <b className="text-ink">{new Date(done.backfill.since).toLocaleTimeString()}</b> through the same idempotent load — no duplicates, no gaps.
              </p>
              <div className="mt-4 h-1.5 bg-surface-2">
                <div className="h-full bg-good transition-all duration-500" style={{ width: `${(finished / 4) * 100}%` }} />
              </div>
              <ul className="mt-4 grid grid-cols-2 gap-2">
                {["orders", "inventory", "warehouse_stock", "sales"].map((ds) => {
                  const r = bf.filter((x) => x.dataset === ds).at(-1);
                  return (
                    <li key={ds} className="flex items-center justify-between border border-line px-3 py-2 text-[13px]">
                      <span className="text-ink">{DS_LABEL[ds]}</span>
                      {r ? <Status tone={statusTone(r.status)}>{r.rows_upserted != null ? `${r.rows_upserted} rows` : r.status}</Status>
                        : <Status tone="mute" pulse>queued</Status>}
                    </li>
                  );
                })}
              </ul>
              {complete && (
                <div className="rise mt-5 flex items-center justify-between gap-3 bg-ink px-4 py-3 text-bg">
                  <span className="inline-flex items-center gap-2 font-medium"><Icon name="check" className="text-accent" /> Back in sync. Intervention closed.</span>
                  <Link href="/" className="text-[13px] underline-offset-2 hover:underline">Overview →</Link>
                </div>
              )}
            </div>
          ) : <p className="text-[14px] text-faint">Starts automatically once the code is verified.</p>}
        </Step>
      </ol>
    </div>
  );
}

function Step({ n, title, active, done, last, children }: {
  n: number; title: string; active: boolean; done: boolean; last?: boolean; children: React.ReactNode;
}) {
  return (
    <li className={`relative flex gap-5 p-6 ${last ? "" : "border-b border-line"} ${!active && !done ? "opacity-50" : ""}`}>
      <span className="grid h-8 w-8 shrink-0 place-items-center border font-mono text-[13px]"
        style={{
          background: done ? "var(--good)" : active ? "var(--accent)" : "transparent",
          borderColor: done ? "var(--good)" : active ? "var(--accent)" : "var(--line-strong)",
          color: done || active ? "var(--on-accent)" : "var(--faint)",
        }}>
        {done ? <Icon name="check" size={15} /> : n}
      </span>
      <div className="min-w-0 flex-1">
        <h2 className="mb-3 font-display text-[18px] font-semibold text-ink">{title}</h2>
        {children}
      </div>
    </li>
  );
}
