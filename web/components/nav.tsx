"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLive, useLiveStatus } from "@/lib/api";
import { PAGE_MOCK_URL } from "@/components/ui";

const LINKS = [
  { href: "/", label: "Overview" },
  { href: "/skus", label: "SKUs" },
  { href: "/warehouses", label: "Warehouses" },
  { href: "/runs", label: "Sync runs" },
  { href: "/alerts", label: "Alerts" },
  { href: "/connectors", label: "Connectors" },
];

export default function Nav() {
  const path = usePathname();
  const live = useLiveStatus();
  const { data } = useLive<{ open_alerts: Record<string, number>; connectors: { status: string }[] }>(
    "/metrics/overview",
  );
  const openCritical = data?.open_alerts?.critical ?? 0;
  const paused = data?.connectors?.filter((c) => c.status === "paused").length ?? 0;

  return (
    <aside className="border-b border-line bg-card md:sticky md:top-0 md:h-screen md:w-56 md:shrink-0 md:border-b-0 md:border-r">
      <div className="flex items-center justify-between px-4 py-4 md:block">
        <div>
          <div className="text-lg font-bold tracking-tight">Q-REX</div>
          <div className="text-xs text-mute">quick-commerce reliability</div>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-mute md:mt-3" title="Live updates via server-sent events">
          <span className={`h-2 w-2 rounded-full ${live ? "bg-good" : "bg-mute"}`} />
          {live ? "live" : "reconnecting"}
        </div>
      </div>
      <nav className="flex gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:pb-0">
        {LINKS.map((l) => {
          const active = l.href === "/" ? path === "/" : path.startsWith(l.href);
          const badge = l.href === "/alerts" ? openCritical : l.href === "/connectors" ? paused : 0;
          return (
            <Link key={l.href} href={l.href}
              className={`flex items-center justify-between whitespace-nowrap rounded-lg px-3 py-2 text-sm ${
                active ? "bg-hover font-medium text-ink" : "text-mute hover:bg-hover hover:text-ink"}`}>
              {l.label}
              {badge > 0 && (
                <span className="ml-2 rounded-full bg-bad px-1.5 text-[11px] font-semibold text-white">{badge}</span>
              )}
            </Link>
          );
        })}
      </nav>
      <div className="hidden px-4 pt-6 text-xs leading-relaxed text-mute md:block">
        All platform traffic goes to the local <b>mock-platform</b>.{" "}
        <a className="text-accent hover:underline" href={PAGE_MOCK_URL} target="_blank" rel="noreferrer">
          Chaos panel ↗
        </a>
      </div>
    </aside>
  );
}
