// Types for scripts/lib/milestone.mjs (plain JS so the GitHub Action needs no npm install).
export function isOnCurve(bytes: Uint8Array): boolean;
export function b58encode(buf: Uint8Array): string;
export function b58decode(str: string): Uint8Array;
export function isWalletAddress(addr: string): boolean;
export function parseExcludeList(json: unknown): Map<string, string>;
export function sumByOwner(rows: { owner: string; amount: bigint }[]): Map<string, bigint>;
export type Counts = { total: number; gte: number };
export type HolderCounts = {
  raw: Counts;
  counted: Counts;
  excluded: { offCurve: Counts & { balanceRaw: bigint }; list: Record<string, Counts & { balanceRaw: bigint }> };
  excludedOwners: { owner: string; reason: string; balanceRaw: bigint }[];
};
export function countHolders(totals: Map<string, bigint>, minRaw: bigint, exclude?: Map<string, string>, onCurve?: (owner: string) => boolean): HolderCounts;
export const WEEK_SECS: number;
export type Reached = { observedAt: string; blockTime: number; slot: number; count: number; snapshotAt: string; snapshotBlockTime: number } | null;
export type MilestoneState = {
  milestone: number;
  runs: { at: string; blockTime: number; slot: number; total: number; gte: number }[];
  firstReached: { gte: Reached; total: Reached };
};
export function updateMilestone(state: Partial<MilestoneState> | null | undefined, obs: { blockTime: number; slot: number; total: number; gte: number }, milestone?: number): MilestoneState;
