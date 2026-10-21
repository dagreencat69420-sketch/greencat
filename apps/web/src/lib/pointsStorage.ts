/**
 * Browser-local PointsStore keyed by wallet pubkey.
 *
 * Scope: wallets that have used THIS browser. Multi-device / global leaderboard
 * needs an indexer or server later — swap this adapter without changing award rules.
 */

import type { PointsStore, PointsWalletState } from "@greencat/sdk";
import { migratePointsFields, vancouverMonthKey } from "@greencat/sdk";

const STORAGE_KEY = "greencat.points.v1";

type Blob = {
  version: 1;
  wallets: Record<string, PointsWalletState>;
};

function readBlob(): Blob {
  if (typeof window === "undefined") return { version: 1, wallets: {} };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { version: 1, wallets: {} };
    const parsed = JSON.parse(raw) as Blob;
    if (!parsed || parsed.version !== 1 || typeof parsed.wallets !== "object") {
      return { version: 1, wallets: {} };
    }
    return parsed;
  } catch {
    return { version: 1, wallets: {} };
  }
}

function writeBlob(blob: Blob) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(blob));
  } catch {
    /* quota / private mode — ignore */
  }
}

export const localPointsStore: PointsStore = {
  get(wallet: string) {
    const key = wallet.trim();
    if (!key) return null;
    const blob = readBlob();
    const row = blob.wallets[key];
    if (!row) return null;
    return migratePointsFields({ ...row, wallet: key }, vancouverMonthKey());
  },

  set(state: PointsWalletState) {
    const key = state.wallet.trim();
    if (!key) return;
    const blob = readBlob();
    blob.wallets[key] = {
      ...state,
      wallet: key,
      updatedAt: Date.now(),
    };
    writeBlob(blob);
  },

  listAll() {
    const blob = readBlob();
    const month = vancouverMonthKey();
    return Object.values(blob.wallets).map((u) =>
      migratePointsFields({ ...u, wallet: u.wallet }, month)
    );
  },
};

export { STORAGE_KEY as POINTS_STORAGE_KEY };
