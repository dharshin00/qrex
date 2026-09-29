"use client";

import type { ReactNode } from "react";
import { Icon, type IconName } from "@/components/icons";

export const PAGE_MOCK_URL = process.env.NEXT_PUBLIC_MOCK_URL ?? "http://localhost:9000";

export const PLATFORMS = ["blinkit", "instamart"] as const;
export const PLATFORM_VAR: Record<string, string> = {
  blinkit: "var(--p-blinkit)",
  instamart: "var(--p-instamart)",
};

export function platformLabel(p: string | null | undefined) {
  if (p === "blinkit") return "Blinkit";
  if (p === "instamart") return "Instamart";
  return p ?? "—";
}

export const DS_LABEL: Record<string, string> = {
  orders: "Orders", inventory: "Inventory", warehouse_stock: "Warehouse stock", sales: "Sales",
};

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------
export function ago(iso: string | null | undefined, now = Date.now()) {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function fmtTime(iso: string | null | undefined, withDate = false) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    ...(withDate ? { month: "short", day: "numeric" } : {}),
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

export const inr = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");
export const inrShort = (n: number) =>
  n >= 1e7 ? `₹${(n / 1e7).toFixed(2)}Cr` : n >= 1e5 ? `₹${(n / 1e5).toFixed(1)}L` : inr(n);
export const num = (n: number) => n.toLocaleString("en-IN");

// ---------------------------------------------------------------------------
// tone
// ---------------------------------------------------------------------------
export type Tone = "good" | "warn" | "bad" | "info" | "mute";
export const TONE_VAR: Record<Tone, string> = {
  good: "var(--good)", warn: "var(--warn)", bad: "var(--bad)", info: "var(--accent)", mute: "var(--faint)",
};

export function statusTone(s: string | null | undefined): Tone {
  switch (s) {
    case "success": case "fresh": case "active": case "sent": case "good": return "good";
    case "retrying": case "degraded": case "warn": case "running": case "paused": return "warn";
    case "failed": case "quarantined": case "stale": case "critical": return "bad";
    case "info": return "info";
    default: return "mute";
  }
}

// ---------------------------------------------------------------------------
// primitives
// ---------------------------------------------------------------------------
export function Dot({ tone = "mute", pulse = false, size = 8 }: { tone?: Tone; pulse?: boolean; size?: number }) {
  return (
    <span className={`inline-block shrink-0 rounded-full ${pulse ? "pulse" : ""}`}
      style={{ width: size, height: size, background: TONE_VAR[tone], color: TONE_VAR[tone] }} />
  );
}

/** Small uppercase status tag with a coloured dot. */
export function Status({ tone, children, pulse }: { tone: Tone; children: ReactNode; pulse?: boolean }) {
  return (
    <span className="label inline-flex items-center gap-1.5 whitespace-nowrap" style={{ color: TONE_VAR[tone] }}>
      <Dot tone={tone} pulse={pulse} size={6} />
      {children}
    </span>
  );
}

export function Card({ title, kicker, action, children, className = "", pad = true }: {
  title?: ReactNode; kicker?: ReactNode; action?: ReactNode; children: ReactNode; className?: string; pad?: boolean;
}) {
  return (
    <section className={`relative min-w-0 bg-surface ${className}`}>
      {(title || action || kicker) && (
        <header className="flex items-start justify-between gap-3 px-5 pb-1 pt-5">
          <div className="min-w-0">
            {title && <h2 className="truncate text-[15px] font-semibold text-ink">{title}</h2>}
            {kicker && <div className="mt-0.5 text-[12px] text-faint">{kicker}</div>}
          </div>
          {action}
        </header>
      )}
      <div className={pad ? "p-5" : ""}>{children}</div>
    </section>
  );
}

export function PageHeader({ kicker, title, sub, action }: {
  kicker?: string; title: ReactNode; sub?: ReactNode; action?: ReactNode;
}) {
  return (
    <div className="mb-10 flex min-h-[120px] flex-wrap items-end justify-between gap-4 md:mb-14">
      <div className="min-w-0">
        {kicker && <div className="kicker">{kicker}</div>}
        <h1 className="mt-2 text-[32px] font-semibold leading-[1.1] tracking-[-0.01em] text-white md:text-[40px]">{title}</h1>
        {sub && <p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-white/70">{sub}</p>}
      </div>
      {action}
    </div>
  );
}

export function Button({ children, onClick, disabled, variant = "default", type = "button", title, icon, size = "md" }: {
  children?: ReactNode; onClick?: () => void; disabled?: boolean; icon?: IconName; size?: "sm" | "md";
  variant?: "default" | "primary" | "accent" | "ghost"; type?: "button" | "submit"; title?: string;
}) {
  const v = {
    default: "border border-white/15 bg-white/5 text-ink hover:bg-white/10",
    primary: "bg-white text-black hover:opacity-90",
    accent: "bg-pink text-white hover:opacity-90",
    ghost: "text-mute hover:bg-white/10 hover:text-ink",
  }[variant];
  const s = size === "sm" ? "h-8 px-2.5 text-[13px]" : "h-9 px-3.5 text-sm";
  return (
    <button type={type} title={title} onClick={onClick} disabled={disabled}
      className={`inline-flex items-center justify-center gap-2 rounded-md font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${s} ${v}`}>
      {icon && <Icon name={icon} size={size === "sm" ? 14 : 16} />}
      {children}
    </button>
  );
}

export function Segmented<T extends string>({ value, onChange, options }: {
  value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode }[];
}) {
  return (
    <div className="inline-flex rounded-full bg-black/60 p-1">
      {options.map((o) => (
        <button key={o.value} onClick={() => onChange(o.value)}
          className={`h-7 rounded-full px-3.5 text-[12.5px] font-medium transition ${value === o.value ? "bg-[#3a3a3f] text-accent" : "text-mute hover:text-ink"}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Select({ value, onChange, options, label }: {
  value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; label: string;
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}
      className="h-8 rounded-md border border-white/10 bg-black/40 px-2 text-[13px] text-ink outline-none focus:border-accent">
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

export function PlatformTag({ p, strong = false }: { p: string | null; strong?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-[13px] ${strong ? "font-medium text-ink" : "text-mute"}`}>
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: PLATFORM_VAR[p ?? ""] ?? "var(--faint)" }} />
      {platformLabel(p)}
    </span>
  );
}

export function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div className="mb-5 flex items-center gap-2 rounded-md border border-bad/40 bg-bad/10 px-4 py-2.5 text-sm text-bad">
      <Icon name="alert" />
      Can&apos;t reach the Q-REX API ({error}). Showing the last data received.
    </div>
  );
}

export function Empty({ icon = "check", title, children }: { icon?: IconName; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
      <span className="grid h-10 w-10 place-items-center rounded-full bg-white/5 text-faint"><Icon name={icon} size={18} /></span>
      <div className="text-[16px] font-semibold text-ink">{title}</div>
      {children && <div className="max-w-sm text-sm text-mute">{children}</div>}
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`skeleton ${className}`} />;
}

export function SkeletonPage() {
  return (
    <div className="space-y-5">
      <Skeleton className="h-3 w-24" />
      <Skeleton className="h-11 w-2/3" />
      <div className="grid grid-cols-2 gap-px lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-28" />)}
      </div>
      <Skeleton className="h-64" />
    </div>
  );
}

/** Horizontal stacked share bar (e.g. stock split across platforms). */
export function ShareBar({ parts, height = 6 }: { parts: { value: number; color: string; label: string }[]; height?: number }) {
  const total = parts.reduce((a, p) => a + p.value, 0) || 1;
  return (
    <div className="flex w-full overflow-hidden bg-surface-2" style={{ height }}
      title={parts.map((p) => `${p.label}: ${num(p.value)}`).join(" · ")}>
      {parts.map((p) => <div key={p.label} style={{ width: `${(p.value / total) * 100}%`, background: p.color }} />)}
    </div>
  );
}

/** Small stat cell for summary strips (use inside a gap-px bg-line grid). */
export function Mini({ label, value, note, tone }: { label: string; value: ReactNode; note?: string; tone?: "good" | "warn" | "bad" }) {
  return (
    <div className="bg-surface px-5 py-4">
      <div className="text-[12.5px] text-mute">{label}</div>
      <div className="mt-1.5 text-[26px] font-bold leading-none tnum"
        style={{ color: tone ? `var(--${tone})` : "var(--ink)" }}>{value}</div>
      {note && <div className="mt-1.5 text-[12px] text-mute">{note}</div>}
    </div>
  );
}
