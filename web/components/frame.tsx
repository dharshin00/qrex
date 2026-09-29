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
    <div className="relative min-h-screen overflow-x-hidden bg-bg">
      <div className={`hero ${HERO[section] ?? "hero-summary"}`} />
      <div className="relative z-[1] mx-auto max-w-[1600px] px-4 pb-12 pt-5 sm:px-8 lg:px-[60px]">
          {/* top bar */}
          <div className="grid grid-cols-1 items-center gap-3 md:grid-cols-[1fr_auto_1fr]">
            <div className="flex items-center gap-2 text-[13px] text-white/90" title={live ? "Live updates connected" : "Reconnecting to live updates"}>
              <span className={`h-2 w-2 rounded-full ${healthy ? "bg-good" : "bg-warn"} ${live ? "pulse" : ""}`}
                style={{ color: healthy ? "var(--good)" : "var(--warn)" }} />
              <span className="truncate">
                Data as of {lastSync ? new Date(lastSync).toLocaleString(undefined, { day: "2-digit", month: "short", year: "2-digit", hour: "2-digit", minute: "2-digit" }).replace(",", "") : "—"}
              </span>
            </div>
            <div className="flex justify-center">
              <nav className="flex max-w-full gap-1 overflow-x-auto rounded-full border border-white/10 bg-black p-1.5 shadow-lg">
                {TABS.map((t) => {
                  const active = t.href === "/" ? path === "/" : path.startsWith(t.href);
                  const badge = t.href === "/alerts" ? openAlerts : t.href === "/connectors" ? paused : 0;
                  return (
                    <Link key={t.href} href={t.href}
                      className={`relative flex min-w-[64px] shrink-0 flex-col items-center gap-0.5 rounded-full px-3 py-1.5 transition ${
                        active ? "bg-[#3a3a3f] text-accent" : "text-white hover:bg-white/10"}`}>
                      <Icon name={t.icon} size={19} strokeWidth={2} />
                      <span className="text-[10.5px] font-semibold leading-none">{t.label}</span>
                      {badge > 0 && (
                        <span className="absolute right-2 top-1 grid h-4 min-w-4 place-items-center rounded-full bg-pink px-1 text-[9.5px] font-bold text-white">{badge}</span>
                      )}
                    </Link>
                  );
                })}
              </nav>
            </div>
            <div className="hidden md:block" />{/* keeps the tab switcher centred */}
          </div>

          {FILTERABLE.has(section) && <FilterButton />}

          <main className="mt-10 md:mt-14">{children}</main>

          <footer className="mt-12 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5 text-[12px] text-faint">
            <span>Q-REX · all platform traffic goes to the local mock seller portal</span>
            <a href={PAGE_MOCK_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 hover:text-white">
              Chaos panel <Icon name="external" size={12} />
            </a>
          </footer>
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
    <div ref={ref} className="absolute right-4 top-[220px] z-20 sm:right-8 lg:right-[36px]">
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
