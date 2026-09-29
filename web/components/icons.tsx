// Inline stroke icons (24px grid, 1.6 stroke) — no icon dependency.
import type { SVGProps } from "react";

const PATHS: Record<string, string> = {
  overview: "M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z",
  sku: "M3 7.5 12 3l9 4.5v9L12 21l-9-4.5zM3 7.5l9 4.5 9-4.5M12 12v9",
  warehouse: "M3 21V9l9-5 9 5v12M7 21v-7h10v7M7 17h10",
  runs: "M3 12h4l3-8 4 16 3-8h4",
  bell: "M6 16V11a6 6 0 1 1 12 0v5l2 2H4zM10 21h4",
  plug: "M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4",
  sun: "M12 4V2M12 22v-2M4.9 4.9 3.5 3.5M20.5 20.5l-1.4-1.4M4 12H2M22 12h-2M4.9 19.1l-1.4 1.4M20.5 3.5l-1.4 1.4M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  moon: "M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z",
  refresh: "M20 11a8 8 0 0 0-14.9-3M4 5v3h3M4 13a8 8 0 0 0 14.9 3M20 19v-3h-3",
  external: "M14 4h6v6M20 4l-9 9M18 14v6H4V6h6",
  check: "M4 12.5 9 17.5 20 6.5",
  x: "M6 6l12 12M18 6 6 18",
  alert: "M12 3 2 20h20zM12 10v4M12 17.5v.5",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2",
  arrow: "M5 12h14M13 6l6 6-6 6",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4",
  upload: "M12 16V4M7 9l5-5 5 5M4 16v4h16v-4",
  key: "M15 7a4 4 0 1 1-3.4 6.1L4 20.5V17h3v-3h3l1.6-1.6A4 4 0 0 1 15 7zM16 8h.01",
  zap: "M13 2 4 14h7l-1 8 9-12h-7z",
  shield: "M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z M9 12l2 2 4-4",
  layers: "M12 3 2 8l10 5 10-5zM2 13l10 5 10-5M2 18l10 5 10-5",
  phone: "M8 2h8a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zM11 18h2",
  pause: "M8 5v14M16 5v14",
  retry: "M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5",
  database: "M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
  sort: "M8 4v16M4 8l4-4 4 4M16 20V4M12 16l4 4 4-4",
  menu: "M4 7h16M4 12h16M4 17h16",
  money: "M9 3h6l-1.5 3h-3zM6.5 9.5C4.7 11.3 4 13.5 4 15.5 4 19 7.5 21 12 21s8-2 8-5.5c0-2-.7-4.2-2.5-6L15 7H9zM12 11v6M10 15.5c.5.5 1.2.8 2 .8 1.1 0 2-.6 2-1.4s-.9-1.2-2-1.4-2-.6-2-1.4.9-1.4 2-1.4c.8 0 1.5.3 2 .8",
  doc: "M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 16h6",
  cart: "M3 4h2l2.4 11h11l2-8H6.2M9 20a1 1 0 1 0 0-.01M18 20a1 1 0 1 0 0-.01",
  filter: "M4 6h16M7 12h10M10 18h4",
  chart: "M5 20V10M11 20V4M17 20v-7",
  store: "M4 9l1.5-5h13L20 9M4 9v11h16V9M4 9c0 1.7 1.3 3 3 3s3-1.3 3-3c0 1.7 1.3 3 2 3s2-1.3 2-3c0 1.7 1.3 3 3 3s3-1.3 3-3M10 20v-5h4v5",
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, className = "", ...rest }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`shrink-0 ${className}`} {...rest}>
      <path d={PATHS[name]} />
    </svg>
  );
}
