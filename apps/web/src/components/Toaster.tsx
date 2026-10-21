"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { explorerUrl } from "@/lib/explorer";

export type ToastTone = "success" | "error" | "info" | "points";
export type ToastInput = { tone?: ToastTone; title: string; body?: string; sig?: string | null; durationMs?: number };
type ToastItem = ToastInput & { id: number; tone: ToastTone };

type Ctx = { toast: (t: ToastInput) => number; dismiss: (id: number) => void };
const ToastCtx = createContext<Ctx | null>(null);

const DEFAULT_MS: Record<ToastTone, number> = { success: 6000, info: 5000, error: 9000, points: 3200 };
const ICON: Record<ToastTone, string> = { success: "✅", info: "ℹ️", error: "⛔", points: "✨" };
const TONE_CLS: Record<ToastTone, string> = {
  success: "border-gc-lime/70 text-gc-neon",
  points: "border-gc-lime/60 text-gc-neon",
  info: "border-gc-lime/30 text-gc-mute",
  error: "border-red-400/60 text-red-100",
};

/** One consistent toast stack for transaction results, wallet events, and points awards. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const toast = useCallback((t: ToastInput) => {
    const id = ++seq.current;
    const item: ToastItem = { ...t, id, tone: t.tone ?? "info" };
    // Same title twice in a row (e.g. a retried action) replaces the old toast instead of stacking.
    setItems((xs) => [...xs.filter((x) => x.title !== item.title), item].slice(-4));
    return id;
  }, []);

  const value = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div
        aria-label="Notifications"
        role="region"
        className="pointer-events-none fixed inset-x-3 top-28 z-[60] flex flex-col items-center gap-2 sm:inset-x-auto sm:right-4 sm:w-96 sm:items-stretch lg:top-16"
      >
        {items.map((t) => (
          <ToastView key={t.id} t={t} onClose={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

function ToastView({ t, onClose }: { t: ToastItem; onClose: () => void }) {
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused) return;
    const id = window.setTimeout(onClose, t.durationMs ?? DEFAULT_MS[t.tone]);
    return () => window.clearTimeout(id);
  }, [paused, onClose, t.durationMs, t.tone]);

  return (
    <div
      role={t.tone === "error" ? "alert" : "status"}
      aria-live={t.tone === "error" ? "assertive" : "polite"}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      className={`gc-toast pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border bg-gc-panel/95 px-4 py-3 text-sm shadow-neonSm backdrop-blur-md sm:max-w-none ${TONE_CLS[t.tone]}`}
    >
      <span aria-hidden className="shrink-0 leading-5">
        {ICON[t.tone]}
      </span>
      <div className="min-w-0 flex-1 break-words leading-5">
        <p className="font-semibold">{t.title}</p>
        {t.body && <p className="mt-0.5 text-xs text-gc-mute">{t.body}</p>}
        {t.sig && (
          <a
            href={explorerUrl("tx", t.sig)}
            target="_blank"
            rel="noreferrer"
            className="mt-1 inline-block font-mono text-xs text-gc-lime underline decoration-gc-lime/40 underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gc-neon"
          >
            View on Solana Explorer <span aria-hidden>↗</span>
          </a>
        )}
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Dismiss notification"
        className="-mr-1 -mt-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-gc-mute hover:bg-white/5 hover:text-gc-neon focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gc-neon"
      >
        <span aria-hidden>✕</span>
      </button>
    </div>
  );
}

export function useToast(): Ctx {
  const v = useContext(ToastCtx);
  // Outside the provider (tests, isolated renders) toasts are a no-op rather than a crash.
  return v ?? { toast: () => 0, dismiss: () => {} };
}
