"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLive, useLiveStatus, type Freshness } from "@/lib/api";
import { usePlatformFilter, type PlatformFilter } from "@/lib/filter";
import { Icon, type IconName } from "@/components/icons";
import { PAGE_MOCK_URL, PLATFORM_VAR } from "@/components/ui";

const TABS: { href: string; label: string; icon: IconName }[] = [
  { href: "/", label: "Summary", icon: "chart" },
  { href: "/orders", label: "Orders", icon: "doc" },
  { href: "/skus", label: "SKUs", icon: "sku" },
  { href: "/warehouses", label: "Stores", icon: "store" },
  { href: "/runs", label: "Syncs", icon: "runs" },
  { href: "/alerts", label: "Alerts", icon: "bell" },
  { href: "/connectors", label: "Sources", icon: "plug" },
];

const HERO: Record<string, string> = {
  "/": "hero-summary", "/skus": "hero-summary", "/warehouses": "hero-summary",
  "/orders": "hero-orders", "/alerts": "hero-alerts", "/runs": "hero-ops", "/connectors": "hero-ops",
};
const FILTERABLE = new Set(["/", "/orders"]);

type Ov = {
  open_alerts: Record<string, number>;
  connectors: { platform: string; status: string; freshness: Freshness[] }[];
};

export default function Frame({ children }: { children: ReactNode }) {
  const path = usePathname();
  const section = "/" + (path.split("/")[1] ?? "");
  const live = useLiveStatus();
  const { data } = useLive<Ov>("/metrics/overview");

  const all = data?.connectors.flatMap((c) => c.freshness) ?? [];
  const lastSync = all.map((f) => f.last_success_at).filter(Boolean).sort().at(-1) ?? null;
  const healthy = !!data && data.connectors.every((c) => c.status === "active") && all.every((f) => f.state === "fresh");
  const openAlerts = (data?.open_alerts?.critical ?? 0) + (data?.open_alerts?.warn ?? 0);
  const paused = data?.connectors.filter((c) => c.status === "paused").length ?? 0;

  return (
    <div className="min-h-screen bg-bg">
      {/* ---------------- sidebar (top bar on small screens) ---------------- */}
      <aside className="sticky top-0 z-30 border-b border-white/5 bg-[#0c0c0e]/95 backdrop-blur lg:fixed lg:inset-y-0 lg:left-0 lg:w-[232px] lg:border-b-0 lg:border-r lg:bg-[#0c0c0e]">
        <div className="flex h-full flex-col">
          <div className="flex items-center justify-between gap-3 px-4 pb-2 pt-4 lg:block lg:px-6 lg:pb-6 lg:pt-8">
            <Link href="/" className="block">
              <div className="text-[24px] font-bold leading-none tracking-[-0.02em] text-white">Q-REX</div>
              <div className="mt-1.5 hidden text-[11px] text-faint lg:block">Quick-commerce reliability</div>
            </Link>
            <div className="flex items-center gap-2 text-[12px] text-white/80 lg:mt-6 lg:rounded-lg lg:bg-white/[0.04] lg:px-3 lg:py-2.5"
              title={live ? "Live updates connected" : "Reconnecting to live updates"}>
              <span className={`h-2 w-2 shrink-0 rounded-full ${healthy ? "bg-good" : "bg-warn"} ${live ? "pulse" : ""}`}
                style={{ color: healthy ? "var(--good)" : "var(--warn)" }} />
              <span className="leading-tight">
                <span className="hidden text-[10.5px] text-faint lg:block">Data as of</span>
                <span className="lg:hidden">As of </span>
                {lastSync ? new Date(lastSync).toLocaleString(undefined, { day: "2-digit", month: "short", year: "2-digit", hour: "2-digit", minute: "2-digit" }).replace(",", "") : "—"}
              </span>
            </div>
          </div>

          <nav className="flex gap-1 overflow-x-auto px-3 pb-3 lg:flex-col lg:gap-1 lg:overflow-visible lg:px-3 lg:pb-0">
            {TABS.map((t) => {
              const active = t.href === "/" ? path === "/" : path.startsWith(t.href);
              const badge = t.href === "/alerts" ? openAlerts : t.href === "/connectors" ? paused : 0;
              return (
                <Link key={t.href} href={t.href}
                  className={`relative flex shrink-0 items-center gap-3 rounded-lg px-3 py-2.5 text-[13.5px] font-medium transition ${
                    active ? "bg-[#2c2c32] text-accent" : "text-white/80 hover:bg-white/[0.06] hover:text-white"}`}>
                  {active && <span className="absolute inset-y-2 left-0 hidden w-[3px] rounded-full bg-accent lg:block" />}
                  <Icon name={t.icon} size={18} strokeWidth={2} />
                  <span className="flex-1">{t.label}</span>
                  {badge > 0 && (
                    <span className="grid h-5 min-w-5 place-items-center rounded-full bg-pink px-1.5 text-[10.5px] font-bold text-white">{badge}</span>
                  )}
                </Link>
              );
            })}
          </nav>

          <div className="mt-auto hidden border-t border-white/5 px-6 py-5 lg:block">
            <a href={PAGE_MOCK_URL} target="_blank" rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-[12.5px] text-mute hover:text-white">
              Chaos panel <Icon name="external" size={12} />
            </a>
            <p className="mt-2 text-[11px] leading-relaxed text-faint">All platform traffic goes to the local mock seller portal.</p>
          </div>
        </div>
      </aside>

      {/* ---------------- content ---------------- */}
      <div className="relative overflow-x-hidden lg:pl-[232px]">
        <div className={`hero ${HERO[section] ?? "hero-summary"}`} />
        <div className="relative z-[1] mx-auto max-w-[1520px] px-4 pb-12 pt-8 sm:px-8 lg:px-[56px] lg:pt-12">
          {FILTERABLE.has(section) && <FilterButton />}
          <main>{children}</main>
        </div>
      </div>
    </div>
  );
}

/** Pink round filter button (top-right of the hero) with a platform popover. */
function FilterButton() {
  const [platform, setPlatform] = usePlatformFilter();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);
  const opts: { v: PlatformFilter; label: string }[] = [
    { v: "", label: "All platforms" }, { v: "blinkit", label: "Blinkit" }, { v: "instamart", label: "Swiggy Instamart" },
  ];
  return (
    <div ref={ref} className="absolute right-4 top-[190px] z-20 sm:right-8 lg:right-[56px] lg:top-[196px]">
      <button onClick={() => setOpen((o) => !o)} aria-label="Filter by platform" title="Filter by platform"
        className="relative grid h-[30px] w-[30px] place-items-center rounded-full bg-pink text-white shadow-lg transition hover:scale-105">
        <Icon name="filter" size={16} strokeWidth={2.4} />
        {platform && <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-black bg-white" />}
      </button>
      {open && (
        <div className="rise absolute right-0 mt-2 w-52 overflow-hidden rounded-xl border border-white/10 bg-[#1f1f22] py-1 shadow-2xl">
          <div className="label px-3 py-2 text-faint">Platform</div>
          {opts.map((o) => (
            <button key={o.v} onClick={() => { setPlatform(o.v); setOpen(false); }}
              className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] hover:bg-white/5 ${platform === o.v ? "text-white" : "text-mute"}`}>
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: o.v ? PLATFORM_VAR[o.v] : "var(--accent)" }} />
              <span className="flex-1">{o.label}</span>
              {platform === o.v && <Icon name="check" size={14} className="text-accent" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
