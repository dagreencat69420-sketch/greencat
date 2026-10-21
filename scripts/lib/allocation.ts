/**
 * Pure allocation logic for the launch airdrop (no network). Used by scripts/airdrop.ts and
 * scripts/airdrop-hold-check.ts; tested in scripts/lib/allocation.test.ts.
 *
 * Terms (docs/airdrop/TERMS.md, "Ranking and Allocation"): among wallets that meet the 100,000 $GC
 * minimum at the snapshot AND complete every other condition (30-day hold, social tasks), the top 1,000 by
 * $GC balance AT THE SNAPSHOT each get an equal share of 100,000,000 $GC. Fewer than 1,000 fully qualified
 * → the pool is split evenly among all of them.
 *
 * Exact integer math on raw units (6 decimals): share = floor(total / N); allocated = share × N;
 * dust = total − allocated (always < N raw units, i.e. < 0.001 $GC for N ≤ 1,000). Dust is never sent:
 * it stays in the airdrop pool and comes back with the reclaim. 100M / 1,000 = exactly 100,000 $GC, 0 dust.
 */

export type Ranked = { wallet: string; balanceRaw: bigint };
/** What to do when wallets with the SAME snapshot balance straddle rank N (Terms are silent → owner decides). */
export type TieBreak = "error" | "include" | "exclude" | "address";

export type Selection = {
  /** every qualified wallet, balance desc then address asc (display order) */
  ranked: Ranked[];
  selected: Ranked[];
  /** balance of the last selected wallet (null if none) */
  cutoffBalanceRaw: bigint | null;
  /** wallets at the cutoff balance when a tie straddles rank N (empty otherwise) */
  tiedAtCutoff: Ranked[];
  note: string;
};

const byBalanceDesc = (a: Ranked, b: Ranked) => (b.balanceRaw > a.balanceRaw ? 1 : b.balanceRaw < a.balanceRaw ? -1 : a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0);

export function selectTopN(qualified: Ranked[], n: number, tieBreak: TieBreak = "error"): Selection {
  if (!Number.isInteger(n) || n < 1) throw new Error(`top N must be a positive integer (got ${n})`);
  const seen = new Set<string>();
  for (const q of qualified) {
    if (seen.has(q.wallet)) throw new Error(`duplicate wallet in qualified list: ${q.wallet}`);
    seen.add(q.wallet);
    if (q.balanceRaw <= 0n) throw new Error(`qualified wallet with no balance: ${q.wallet}`);
  }
  const ranked = [...qualified].sort(byBalanceDesc);
  if (ranked.length <= n)
    return { ranked, selected: ranked, cutoffBalanceRaw: ranked.at(-1)?.balanceRaw ?? null, tiedAtCutoff: [], note: `${ranked.length} qualified ≤ ${n}: all selected` };
  const cutoff = ranked[n - 1].balanceRaw;
  if (ranked[n].balanceRaw < cutoff)
    return { ranked, selected: ranked.slice(0, n), cutoffBalanceRaw: cutoff, tiedAtCutoff: [], note: `top ${n} of ${ranked.length} qualified` };
  const above = ranked.filter((r) => r.balanceRaw > cutoff);
  const tied = ranked.filter((r) => r.balanceRaw === cutoff);
  const desc = `${tied.length} wallets share the cutoff balance ${cutoff} raw for ${n - above.length} remaining place(s)`;
  switch (tieBreak) {
    case "include": return { ranked, selected: [...above, ...tied], cutoffBalanceRaw: cutoff, tiedAtCutoff: tied, note: `tie: ${desc}; all tied included (${above.length + tied.length} selected)` };
    case "exclude": return { ranked, selected: above, cutoffBalanceRaw: above.at(-1)?.balanceRaw ?? null, tiedAtCutoff: tied, note: `tie: ${desc}; all tied excluded (${above.length} selected)` };
    case "address": return { ranked, selected: ranked.slice(0, n), cutoffBalanceRaw: cutoff, tiedAtCutoff: tied, note: `tie: ${desc}; broken by address order` };
    default: throw new Error(`tie at rank ${n}: ${desc}. Re-run with --tie-break include|exclude|address (owner decision)`);
  }
}

export type Split = { shareRaw: bigint; allocatedRaw: bigint; dustRaw: bigint };
export function equalSplit(totalRaw: bigint, count: number): Split {
  if (!Number.isInteger(count) || count < 1) throw new Error("equal split needs at least one wallet");
  if (totalRaw <= 0n) throw new Error("total must be positive");
  const shareRaw = totalRaw / BigInt(count);
  if (shareRaw === 0n) throw new Error("total too small: share rounds to 0");
  const allocatedRaw = shareRaw * BigInt(count);
  return { shareRaw, allocatedRaw, dustRaw: totalRaw - allocatedRaw };
}
