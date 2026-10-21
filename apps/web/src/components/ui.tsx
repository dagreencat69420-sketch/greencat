"use client";

import { useState, type ReactNode } from "react";
import { explorerUrl, shortKey } from "@/lib/explorer";
import { friendlyError, type FriendlyError } from "@/lib/errors";
import { CLUSTER } from "@/lib/config";
import { SocialLinks } from "@/components/Socials";

/* ── Button / field classes (focus-visible rings on everything) ─────────────────────────── */

const focus =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gc-neon focus-visible:ring-offset-2 focus-visible:ring-offset-gc-bg";
const base = `inline-flex min-h-[44px] items-center justify-center gap-2 rounded-full px-5 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none ${focus}`;

export const btn = {
  primary: `${base} bg-gc-lime text-black shadow-neonSm hover:bg-gc-neon`,
  secondary: `${base} border border-gc-lime/50 text-gc-lime hover:bg-gc-lime/10`,
  ghost: `${base} border border-gc-border text-gc-mute hover:border-gc-lime/40 hover:text-gc-lime`,
  warn: `${base} border border-amber-400/60 text-amber-100 hover:bg-amber-500/10`,
  small: `inline-flex min-h-[36px] items-center justify-center gap-1 rounded-full border border-gc-lime/40 px-3 text-xs font-semibold text-gc-lime transition hover:bg-gc-lime/10 disabled:cursor-not-allowed disabled:opacity-40 ${focus}`,
};

export const field = `w-full min-h-[44px] rounded-xl border border-gc-border bg-black/40 px-3 py-2 text-sm text-white placeholder:text-gc-mute/70 ${focus} focus-visible:border-gc-lime/60`;
export const labelCls = "block text-xs font-medium text-gc-mute";
export const focusRing = focus;

/* ── Layout ─────────────────────────────────────────────────────────────────────────── */

export function PageHeader({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children?: ReactNode }) {
  return (
    <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-black tracking-tight text-gc-neon sm:text-3xl">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-gc-mute">{subtitle}</p>}
      </div>
      {children}
    </header>
  );
}

export function Panel({
  title,
  subtitle,
  actions,
  children,
  className = "",
  labelledBy,
}: {
  title?: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  labelledBy?: string;
}) {
  const id = labelledBy ?? (title ? `panel-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}` : undefined);
  return (
    <section
      aria-labelledby={title ? id : undefined}
      className={`rounded-2xl border border-gc-border bg-gc-panel/90 p-4 shadow-neonSm backdrop-blur sm:p-6 ${className}`}
    >
      {(title || actions) && (
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            {title && (
              <h2 id={id} className="text-lg font-semibold text-gc-neon">
                {title}
              </h2>
            )}
            {subtitle && <div className="mt-0.5 text-xs leading-relaxed text-gc-mute">{subtitle}</div>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, tone = "neon" }: { label: string; value: ReactNode; tone?: "neon" | "lime" | "white" }) {
  const c = tone === "neon" ? "text-gc-neon" : tone === "lime" ? "text-gc-lime" : "text-white";
  return (
    <div className="min-w-0 rounded-xl border border-gc-border/80 bg-black/30 p-3">
      <div className="text-[11px] uppercase tracking-wide text-gc-mute">{label}</div>
      <div className={`mt-1 truncate text-base font-semibold tabular-nums sm:text-lg ${c}`}>{value}</div>
    </div>
  );
}

/* ── Loading / empty / notices ─────────────────────────────────────────────────────── */

export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden className={`animate-pulse rounded-lg bg-gc-lime/10 motion-reduce:animate-none ${className}`} />;
}

export function PanelSkeleton({ rows = 3, label = "Loading" }: { rows?: number; label?: string }) {
  return (
    <div role="status" aria-live="polite" className="space-y-3">
      <span className="sr-only">{label}…</span>
      <div className="grid grid-cols-2 gap-2">
        <Skeleton className="h-16" />
        <Skeleton className="h-16" />
      </div>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className={`h-4 ${i % 2 ? "w-2/3" : "w-full"}`} />
      ))}
      <Skeleton className="h-11 w-40 rounded-full" />
    </div>
  );
}

export function EmptyState({ icon = "🐱", title, children, action }: { icon?: string; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-gc-border bg-black/20 px-4 py-8 text-center">
      <span className="text-3xl" aria-hidden>
        {icon}
      </span>
      <p className="font-semibold text-white">{title}</p>
      {children && <div className="max-w-sm text-sm text-gc-mute">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/**
 * Friendly "not live yet" state for features that need the on-chain program (it isn't deployed on this
 * cluster yet). Replaces raw errors / empty panels with a branded launch card and the official channels.
 */
export function LaunchingSoon({ feature, icon = "🚀", children }: { feature: string; icon?: string; children?: ReactNode }) {
  const net = CLUSTER === "mainnet-beta" ? "mainnet" : CLUSTER === "devnet" ? "Devnet" : CLUSTER;
  return (
    <div className="relative overflow-hidden rounded-xl border border-gc-lime/30 bg-[radial-gradient(circle_at_20%_0%,rgba(184,255,60,0.14),transparent_60%)] px-4 py-6 sm:px-6">
      <div className="flex flex-col items-center gap-4 text-center sm:flex-row sm:items-start sm:text-left">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/mascot/greencat-avatar.webp"
          alt=""
          width={88}
          height={88}
          className="h-20 w-20 shrink-0 rounded-2xl border-2 border-gc-lime/60 bg-gc-lime/10 object-contain p-1.5 shadow-neonSm sm:h-[88px] sm:w-[88px]"
        />
        <div className="min-w-0 space-y-2">
          <p className="inline-flex items-center gap-1.5 rounded-full border border-gc-lime/40 bg-gc-lime/10 px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wider text-gc-lime">
            <span aria-hidden className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-gc-lime opacity-60 motion-reduce:hidden" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-gc-lime" />
            </span>
            Launching soon on {net}
          </p>
          <h3 className="text-lg font-black text-white">
            <span aria-hidden>{icon} </span>
            {feature} isn&apos;t live yet
          </h3>
          <div className="max-w-prose text-sm leading-relaxed text-gc-mute">
            {children ?? (
              <p>
                The GreenCat program is getting its final checks before it goes live on {net}. Nothing is broken and nothing is needed from
                you. This page lights up automatically at launch.
              </p>
            )}
          </div>
          <p className="pt-1 text-xs text-gc-mute">Follow the official channels for the launch call:</p>
          <SocialLinks className="justify-center sm:justify-start" />
        </div>
      </div>
    </div>
  );
}

const tones = {
  info: "border-gc-lime/30 bg-gc-lime/5 text-gc-mute",
  warn: "border-amber-400/40 bg-amber-500/10 text-amber-100",
  error: "border-red-400/50 bg-red-500/10 text-red-100",
  success: "border-gc-lime/60 bg-gc-lime/10 text-gc-neon",
} as const;
const toneIcon = { info: "ℹ️", warn: "⚠️", error: "⛔", success: "✅" } as const;

export function Notice({ tone = "info", title, children, action }: { tone?: keyof typeof tones; title?: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div role={tone === "error" ? "alert" : "status"} className={`flex flex-wrap items-start gap-x-3 gap-y-2 rounded-xl border px-4 py-3 text-sm ${tones[tone]}`}>
      <span aria-hidden className="shrink-0 leading-5">
        {toneIcon[tone]}
      </span>
      <div className="min-w-0 flex-1 basis-[12rem] break-words leading-5">
        {title && <p className="font-semibold">{title}</p>}
        {children}
      </div>
      {action && <div className="ml-auto shrink-0">{action}</div>}
    </div>
  );
}

/** Friendly error with optional retry and a collapsible technical detail. */
export function ErrorNotice({ error, onRetry, onDismiss }: { error: unknown; onRetry?: () => void; onDismiss?: () => void }) {
  const [open, setOpen] = useState(false);
  if (!error) return null;
  const f: FriendlyError = isFriendly(error) ? error : friendlyError(error);
  const tone = f.kind === "rejected" ? "info" : "error";
  return (
    <Notice
      tone={tone}
      title={f.message}
      action={
        (onRetry || onDismiss) && (
          <div className="flex gap-2">
            {onRetry && f.kind !== "rejected" && (
              <button type="button" className={btn.small} onClick={onRetry}>
                Try again
              </button>
            )}
            {onDismiss && (
              <button type="button" className={btn.small} onClick={onDismiss} aria-label="Dismiss message">
                ✕
              </button>
            )}
          </div>
        )
      }
    >
      {f.hint && <p className="mt-1 text-xs opacity-90">{f.hint}</p>}
      {f.detail && (
        <div className="mt-1">
          <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className={`text-[11px] underline opacity-80 ${focus}`}>
            {open ? "Hide details" : "Details"}
          </button>
          {open && <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] opacity-80">{f.detail}</pre>}
        </div>
      )}
    </Notice>
  );
}

function isFriendly(e: unknown): e is FriendlyError {
  return typeof e === "object" && e !== null && "kind" in e && "message" in e && !(e instanceof Error);
}

export function TxLink({ sig, label = "View transaction" }: { sig: string; label?: string }) {
  return (
    <a
      href={explorerUrl("tx", sig)}
      target="_blank"
      rel="noreferrer"
      className={`inline-flex items-center gap-1 font-mono text-xs text-gc-lime underline decoration-gc-lime/40 underline-offset-2 hover:decoration-gc-lime ${focus}`}
    >
      {label} <span aria-hidden>↗</span>
      <span className="sr-only">(opens Solana Explorer, signature {shortKey(sig, 6)})</span>
    </a>
  );
}

export function SuccessNotice({ title, sig, children }: { title: string; sig?: string | null; children?: ReactNode }) {
  return (
    <Notice tone="success" title={title}>
      {children}
      {sig && (
        <p className="mt-1">
          <TxLink sig={sig} />
        </p>
      )}
    </Notice>
  );
}

/* ── Countdown ─────────────────────────────────────────────────────────────────────── */

export function formatDuration(secs: number): string {
  if (secs <= 0) return "0s";
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s.toString().padStart(2, "0")}s`;
  return `${s}s`;
}

/** Progress bar + "expires in" label. `now`/`start`/`end` are unix seconds. */
export function ExpiryBar({
  now,
  start,
  end,
  label = "Refund opens in",
  doneLabel = "Expired",
  doneValue = "refund available",
}: {
  now: number;
  start: number;
  end: number;
  label?: string;
  doneLabel?: string;
  doneValue?: string;
}) {
  const total = Math.max(1, end - start);
  const left = Math.max(0, end - now);
  const pct = Math.min(100, Math.max(0, ((total - left) / total) * 100));
  return (
    <div>
      <div className="flex justify-between text-xs">
        <span>{left > 0 ? label : doneLabel}</span>
        <span className="font-mono tabular-nums" aria-live="off">
          {left > 0 ? formatDuration(left) : doneValue}
        </span>
      </div>
      <div
        className="mt-1 h-2 overflow-hidden rounded-full bg-black/40"
        role="progressbar"
        aria-label={left > 0 ? `${label} ${formatDuration(left)}` : `${doneLabel}: ${doneValue}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
      >
        <div className="h-full rounded-full bg-gradient-to-r from-gc-lime to-amber-300 transition-[width] duration-1000 motion-reduce:transition-none" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
