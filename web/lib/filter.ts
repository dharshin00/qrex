"use client";

import { useEffect, useState } from "react";

/** Global platform filter (driven by the pink filter button). "" = all platforms. */
export type PlatformFilter = "" | "blinkit" | "instamart";

let current: PlatformFilter = "";
const subs = new Set<(p: PlatformFilter) => void>();

export function setPlatformFilter(p: PlatformFilter) {
  current = p;
  try { sessionStorage.setItem("qrex-platform", p); } catch {}
  subs.forEach((f) => f(p));
}

export function usePlatformFilter(): [PlatformFilter, (p: PlatformFilter) => void] {
  const [p, setP] = useState<PlatformFilter>(current);
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem("qrex-platform") as PlatformFilter | null;
      if (saved !== null && saved !== current) { current = saved; }
    } catch {}
    setP(current);
    subs.add(setP);
    return () => void subs.delete(setP);
  }, []);
  return [p, setPlatformFilter];
}
