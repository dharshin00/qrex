"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/icons";

type Toast = { id: number; tone: "good" | "bad" | "info"; text: string };
const listeners = new Set<(t: Toast) => void>();
let seq = 0;

/** Fire-and-forget notification from anywhere in the UI. */
export function toast(text: string, tone: Toast["tone"] = "good") {
  const t = { id: ++seq, tone, text };
  listeners.forEach((f) => f(t));
}

export function Toaster() {
  const [items, setItems] = useState<Toast[]>([]);
  useEffect(() => {
    const add = (t: Toast) => {
      setItems((xs) => [...xs.slice(-3), t]);
      setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== t.id)), 4200);
    };
    listeners.add(add);
    return () => void listeners.delete(add);
  }, []);
  return (
    <div className="pointer-events-none fixed bottom-5 right-5 z-50 flex w-[min(380px,calc(100vw-2.5rem))] flex-col gap-2" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className="rise pointer-events-auto flex items-start gap-3 border border-line-strong bg-surface px-4 py-3 text-sm text-ink shadow-xl">
          <span className="mt-0.5" style={{ color: t.tone === "bad" ? "var(--bad)" : t.tone === "info" ? "var(--accent)" : "var(--good)" }}>
            <Icon name={t.tone === "bad" ? "alert" : t.tone === "info" ? "zap" : "check"} />
          </span>
          <span className="flex-1">{t.text}</span>
        </div>
      ))}
    </div>
  );
}
