"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(API + path, { cache: "no-store", ...init });
  if (!r.ok) {
    let detail = `${r.status} ${r.statusText}`;
    try {
      const j = await r.json();
      detail = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail ?? j);
    } catch {}
    throw new Error(detail);
  }
  return r.json() as Promise<T>;
}

export const post = <T = unknown,>(path: string, body?: unknown) =>
  api<T>(path, {
    method: "POST",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

// ---------------------------------------------------------------------------
// One shared SSE connection; pages subscribe and refetch on change events.
// ---------------------------------------------------------------------------
type Listener = () => void;
const listeners = new Set<Listener>();
const statusListeners = new Set<(s: boolean) => void>();
let es: EventSource | null = null;
let connected = false;

function ensureStream() {
  if (es || typeof window === "undefined") return;
  es = new EventSource(API + "/events");
  const setStatus = (s: boolean) => {
    connected = s;
    statusListeners.forEach((f) => f(s));
  };
  es.onopen = () => setStatus(true);
  es.onerror = () => setStatus(false);
  es.addEventListener("ping", () => setStatus(true));
  es.addEventListener("change", () => listeners.forEach((f) => f()));
}

export function useLiveStatus() {
  const [s, setS] = useState(connected);
  useEffect(() => {
    ensureStream();
    statusListeners.add(setS);
    return () => void statusListeners.delete(setS);
  }, []);
  return s;
}

/** Fetch `path`, refetch on server change events (debounced) and every 15s as a fallback. */
export function useLive<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    if (!path) return;
    try {
      setData(await api<T>(path));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [path]);

  useEffect(() => {
    load();
    ensureStream();
    const onChange = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(load, 300);
    };
    listeners.add(onChange);
    const poll = setInterval(load, 15000);
    return () => {
      listeners.delete(onChange);
      clearInterval(poll);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load]);

  return { data, error, reload: load };
}

/** Re-render every `ms` so relative times stay current. */
export function useNow(ms = 5000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

// ---------------------------------------------------------------------------
// Types (subset of API responses the UI uses)
// ---------------------------------------------------------------------------
export type Freshness = {
  dataset: string;
  state: "fresh" | "stale" | "degraded";
  last_success_at: string | null;
  age_seconds: number | null;
  sla_seconds: number;
  interval_seconds: number;
  last_status: string | null;
  last_source_path: string | null;
  last_error: string | null;
};

export type ConnectorT = {
  id: number;
  platform: string;
  display_name: string;
  enabled: boolean;
  status: "active" | "paused";
  paused_at: string | null;
  config: {
    schedules?: Record<string, number>;
    freshness_sla?: Record<string, number>;
    low_stock_threshold?: number;
    seller_id?: string;
  };
  session: { status: string; expires_at: string; created_at: string } | null;
  open_intervention: { id: number; kind: string; requested_at: string; note: string } | null;
  consents: { source_path: string; granted_by: string; scope: string; granted_at: string }[];
  freshness: Freshness[];
  reauth_url: string;
};

export type AlertT = {
  id: number;
  kind: string;
  severity: "info" | "warn" | "critical";
  platform: string | null;
  dataset: string | null;
  message: string;
  payload: Record<string, unknown>;
  occurrences: number;
  created_at: string;
  last_seen_at: string;
  resolved_at: string | null;
  delivered: Record<string, string>;
};

export type RunT = {
  id: number;
  platform: string;
  dataset: string;
  status: string;
  mode: string;
  attempt: number;
  source_path: string | null;
  window_start: string | null;
  window_end: string | null;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  rows_in: number | null;
  rows_upserted: number | null;
  error: string | null;
};
