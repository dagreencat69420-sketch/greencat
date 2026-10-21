/**
 * VRF expiry (`Config.vrf_expiry_secs`) helpers for the /admin "Set VRF expiry" control.
 *
 * The program (`set_vrf_expiry`, admin only) accepts 3,600 s (1 h) … 604,800 s (7 days) in every real build
 * (`programs/greencat/src/vrf.rs`: VRF_EXPIRY_MIN_SECS / VRF_EXPIRY_MAX_SECS; only the test-only
 * `localnet-short-windows` build lowers the minimum). The same value is used for:
 *  - per-mint reveal: an unfulfilled ORAO request can be re-requested after it (`request_mint_vrf`);
 *  - (the wheel, which also used it, was removed Oct 12, 2026)
 */
import type { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { buildSetVrfExpiryIx } from "./instructions";

export const VRF_EXPIRY_MIN_SECS = 3_600;
export const VRF_EXPIRY_MAX_SECS = 7 * 86_400;
export const VRF_EXPIRY_DEFAULT_SECS = 86_400;

export type VrfExpiryUnit = "seconds" | "minutes";

export type VrfExpiryParse = { ok: true; secs: number } | { ok: false; error: string };

/** Short label: 3600 → "1 h", 86400 → "24 h", 604800 → "7 days", 5400 → "90 min", 3601 → "3,601 s". */
export function formatVrfExpiry(secs: number | bigint): string {
  const s = Number(secs);
  if (!Number.isFinite(s) || s < 0) return "—";
  if (s >= 2 * 86_400 && s % 86_400 === 0) return `${s / 86_400} days`;
  if (s % 3_600 === 0 && s >= 3_600) return `${s / 3_600} h`;
  if (s % 60 === 0) return `${s / 60} min`;
  return `${s.toLocaleString("en-US")} s`;
}

/**
 * Parse what the admin typed ("3600", "3,600", " 60 ") in the chosen unit into whole seconds and check it
 * against the program's bounds. Never throws.
 */
export function parseVrfExpiryInput(
  input: string,
  unit: VrfExpiryUnit,
  bounds: { min?: number; max?: number } = {}
): VrfExpiryParse {
  const min = bounds.min ?? VRF_EXPIRY_MIN_SECS;
  const max = bounds.max ?? VRF_EXPIRY_MAX_SECS;
  const s = input.replace(/[,_\s]/g, "");
  if (!s) return { ok: false, error: "Enter a value." };
  if (!/^\d+$/.test(s)) return { ok: false, error: `Enter a whole number of ${unit}.` };
  const n = Number(s);
  const secs = unit === "minutes" ? n * 60 : n;
  if (!Number.isSafeInteger(secs)) return { ok: false, error: "That number is too large." };
  const range = unit === "minutes" ? `${min / 60}–${max / 60} minutes` : `${min.toLocaleString("en-US")}–${max.toLocaleString("en-US")} seconds`;
  if (secs < min) return { ok: false, error: `Too short: the minimum is ${formatVrfExpiry(min)} (${range}).` };
  if (secs > max) return { ok: false, error: `Too long: the maximum is ${formatVrfExpiry(max)} (${range}).` };
  return { ok: true, secs };
}

/** `set_vrf_expiry` after re-checking the bounds (throws on an out-of-range value instead of letting the program refuse it). */
export function buildSetVrfExpiryIxChecked(p: { authority: PublicKey; expirySecs: number; programId?: PublicKey }): TransactionInstruction {
  if (!Number.isSafeInteger(p.expirySecs) || p.expirySecs < VRF_EXPIRY_MIN_SECS || p.expirySecs > VRF_EXPIRY_MAX_SECS) {
    throw new RangeError(`VRF expiry must be ${VRF_EXPIRY_MIN_SECS}–${VRF_EXPIRY_MAX_SECS} s, got ${p.expirySecs}`);
  }
  return buildSetVrfExpiryIx(p);
}
