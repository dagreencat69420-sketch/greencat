/**
 * Global backend (apps/api) wiring. Set NEXT_PUBLIC_API_URL to enable server-authoritative
 * Points + indexer-backed marketplace browse. Unset → localStorage fallback (offline mode).
 */
import { GreenCatApiClient } from "@greencat/sdk";

export const API_URL: string | null = process.env.NEXT_PUBLIC_API_URL?.trim() || null;

export function createApiClient(): GreenCatApiClient | null {
  return API_URL ? new GreenCatApiClient(API_URL) : null;
}

/** Shared read-only client (listings etc.). Points use a per-provider instance holding the session. */
export const publicApi: GreenCatApiClient | null = createApiClient();

const SESSION_PREFIX = "greencat.session.v1.";

type StoredSession = { token: string; expiresAt: string };

export function loadSession(wallet: string): StoredSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(SESSION_PREFIX + wallet);
    if (!raw) return null;
    const s = JSON.parse(raw) as StoredSession;
    // 30s safety margin
    if (!s.token || Date.parse(s.expiresAt) - 30_000 < Date.now()) {
      window.localStorage.removeItem(SESSION_PREFIX + wallet);
      return null;
    }
    return s;
  } catch {
    return null;
  }
}

export function saveSession(wallet: string, s: StoredSession) {
  try {
    window.localStorage.setItem(SESSION_PREFIX + wallet, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

export function clearSession(wallet: string) {
  try {
    window.localStorage.removeItem(SESSION_PREFIX + wallet);
  } catch {
    /* ignore */
  }
}
