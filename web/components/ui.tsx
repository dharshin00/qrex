"use client";

import type { ReactNode } from "react";

export const PLATFORM_COLOR: Record<string, string> = {
  blinkit: "#d97706",
  instamart: "#2563eb",
};

export function platformLabel(p: string | null | undefined) {
  if (p === "blinkit") return "Blinkit";
  if (p === "instamart") return "Instamart";
  return p ?? "—";
}

export function ago(iso: string | null | undefined, now = Date.now()) {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function fmtTime(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

export const inr = (n: number) =>
  "₹" + n.toLocaleString("en-IN", { maximumFractionDigits: 0 });

export function Card({ title, action, children, className = "" }: {
  title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string;
}) {
  return (
    <section className={`min-w-0 rounded-xl border border-line bg-card p-4 ${className}`}>
      {(title || action) && (
        <div className="mb-3 flex items-center justify-between gap-2">
          {title && <h2 className="text-sm font-semibold text-ink">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

const TONE: Record<string, string> = {
  good: "bg-good/15 text-good ring-good/30",
  warn: "bg-warn/15 text-warn ring-warn/30",
  bad: "bg-bad/15 text-bad ring-bad/30",
  info: "bg-accent/15 text-accent ring-accent/30",
  mute: "bg-mute/10 text-mute ring-mute/20",
};

export function Badge({ tone = "mute", children }: { tone?: keyof typeof TONE | string; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${TONE[tone] ?? TONE.mute}`}>
      {children}
    </span>
  );
}

export function statusTone(s: string | null | undefined) {
  switch (s) {
    case "success": case "fresh": case "active": case "sent": return "good";
    case "retrying": case "degraded": case "warn": case "running": return "warn";
    case "failed": case "quarantined": case "stale": case "paused": case "critical": return "bad";
    default: return "mute";
  }
}

export function PlatformTag({ p }: { p: string | null }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-ink">
      <span className="h-2 w-2 rounded-full" style={{ background: PLATFORM_COLOR[p ?? ""] ?? "#888" }} />
      {platformLabel(p)}
    </span>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: string }) {
  const color = tone === "bad" ? "text-bad" : tone === "good" ? "text-good" : tone === "warn" ? "text-warn" : "text-ink";
  return (
    <div className="rounded-xl border border-line bg-card p-4">
      <div className="text-xs text-mute">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${color}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-mute">{sub}</div>}
    </div>
  );
}

export function Button({ children, onClick, disabled, variant = "default", type = "button", title }: {
  children: ReactNode; onClick?: () => void; disabled?: boolean;
  variant?: "default" | "primary" | "danger" | "ghost"; type?: "button" | "submit"; title?: string;
}) {
  const v = {
    default: "border border-line bg-card hover:bg-hover text-ink",
    primary: "bg-accent text-white hover:opacity-90",
    danger: "bg-bad text-white hover:opacity-90",
    ghost: "text-accent hover:bg-hover",
  }[variant];
  return (
    <button type={type} title={title} onClick={onClick} disabled={disabled}
      className={`rounded-lg px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${v}`}>
      {children}
    </button>
  );
}

export function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div className="rounded-lg border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
      Can&apos;t reach the Q-REX API ({error}). Showing the last data we had.
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="py-8 text-center text-sm text-mute">{children}</div>;
}

export function PageHeader({ title, sub, action }: { title: string; sub?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold text-ink">{title}</h1>
        {sub && <p className="mt-0.5 text-sm text-mute">{sub}</p>}
      </div>
      {action}
    </div>
  );
}

/** Minimal bar chart (vertical). Series share the x axis; bars are grouped. */
export function Bars({ data, series, height = 160, format = (n: number) => String(n) }: {
  data: { label: string; values: Record<string, number> }[];
  series: { key: string; color: string; label: string }[];
  height?: number;
  format?: (n: number) => string;
}) {
  const max = Math.max(1, ...data.flatMap((d) => series.map((s) => d.values[s.key] ?? 0)));
  return (
    <div>
      <div className="flex items-end gap-2" style={{ height }}>
        {data.map((d) => (
          <div key={d.label} className="flex h-full flex-1 flex-col justify-end">
            <div className="flex h-full items-end justify-center gap-0.5">
              {series.map((s) => {
                const v = d.values[s.key] ?? 0;
                return (
                  <div key={s.key} className="group relative flex-1 rounded-t-[3px]"
                    style={{ height: `${(v / max) * 100}%`, minHeight: v ? 2 : 0, background: s.color, maxWidth: 28 }}>
                    <span className="pointer-events-none absolute -top-5 left-1/2 hidden -translate-x-1/2 whitespace-nowrap rounded bg-ink px-1 text-[10px] text-bg group-hover:block">
                      {format(v)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-2 border-t border-line pt-1">
        {data.map((d) => (
          <div key={d.label} className="flex-1 truncate text-center text-[10px] text-mute">{d.label}</div>
        ))}
      </div>
      {series.length > 1 && (
        <div className="mt-2 flex gap-3 text-xs text-mute">
          {series.map((s) => (
            <span key={s.key} className="inline-flex items-center gap-1">
              <span className="h-2 w-2 rounded-sm" style={{ background: s.color }} />{s.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export const PAGE_MOCK_URL = process.env.NEXT_PUBLIC_MOCK_URL ?? "http://localhost:9000";
