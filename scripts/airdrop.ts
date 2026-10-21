#!/usr/bin/env -S npx tsx
/**
 * Merkle airdrop tooling (audit GC-22). Replaces the old on-chain "even distribution" airdrop.
 *
 * 1) Snapshot holders + build the tree (read-only RPC; writes files, sends nothing):
 *      npx tsx scripts/airdrop.ts snapshot --id 1 --total-ui 1000000 [--split equal|pro-rata]
 *        [--min-holding-ui 100000] [--prior snapshots/a.json,snapshots/b.json] [--exclude k1,k2]
 *        [--include-pdas] [--expiry-days 30] [--balances balances.json] [--out airdrops/]
 *    - balances: all token accounts of $GC (getProgramAccounts, mint filter), summed per owner.
 *    - --prior: per-wallet MIN across earlier balance snapshots + now (defeats borrow-for-the-snapshot).
 *    - excludes program treasuries / off-curve (PDA-owned: pools, LPs, vaults) unless --include-pdas.
 *    - writes airdrops/balances-<ts>.json and airdrops/airdrop-<id>-proofs.json (publish the latter).
 *    Launch airdrop (Terms, docs/airdrop/TERMS.md): pass the hold checker's output (wallet → balance AT THE
 *    SNAPSHOT, fully-qualified wallets only) and the top-N rule:
 *      --balances airdrops/hold/hold-qualified.json --top 1000 --split equal --total-ui 100000000
 *        [--tie-break error|include|exclude|address] [--exclude-file <file>]
 *      (scripts/airdrop-exclude.json is applied by default; --no-exclude-file turns it off)
 *    → the top 1,000 by snapshot balance each get floor(total / N) raw; fewer than 1,000 → all of them.
 *    Exact integer math; the dust (total − share × N, < N raw units = < 0.001 $GC) is NOT allocated: it stays
 *    in the airdrop pool and returns with the reclaim. Default tie-break "error" stops if wallets with the
 *    same balance straddle rank N (the Terms don't cover ties; owner decides).
 * 2) Post the root (Config authority / Squads vault; reserves the total in the airdrop pool):
 *      npx tsx scripts/airdrop.ts create airdrops/airdrop-1-proofs.json
 * 3) Users claim in the web app (AirdropPanel) with the published proofs file.
 * 4) After expiry (+3 days since the last pause change), release unclaimed funds:
 *      npx tsx scripts/airdrop.ts reclaim 1
 */
import fs from "node:fs";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import {
  buildCreateAirdropIx,
  buildMerkleTree,
  buildReclaimAirdropIx,
  deriveAirdropDistributionPda,
  deriveAllTreasuryAddresses,
  merkleLeaf,
  verifyMerkleProof,
} from "@greencat/sdk";
import { PROGRAM_ID, ROOT, conn, die, gcMintAndProgram, loadKeypair, readConfig, send, uiToRawGc } from "./lib/common";
import { equalSplit, selectTopN, type TieBreak } from "./lib/allocation";
import { parseExcludeList } from "./lib/milestone.mjs";

const [cmd, ...rest] = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
}
const has = (name: string) => rest.includes(`--${name}`);
const DEFAULT_EXCLUDE_FILE = path.join(ROOT, "scripts", "airdrop-exclude.json");

type Balances = Record<string, string>; // owner → raw amount

async function liveBalances(gcMint: PublicKey, tokenProgram: PublicKey): Promise<Balances> {
  const accs = await conn.getProgramAccounts(tokenProgram, {
    filters: [
      ...(tokenProgram.equals(TOKEN_2022_PROGRAM_ID) ? [] : [{ dataSize: 165 }]),
      { memcmp: { offset: 0, bytes: gcMint.toBase58() } },
    ],
  });
  const out = new Map<string, bigint>();
  for (const a of accs) {
    const d = a.account.data;
    if (d.length < 165) continue;
    const owner = new PublicKey(d.subarray(32, 64)).toBase58();
    const amount = d.readBigUInt64LE(64);
    if (amount > 0n) out.set(owner, (out.get(owner) ?? 0n) + amount);
  }
  return Object.fromEntries([...out].map(([k, v]) => [k, v.toString()]));
}

async function snapshot() {
  const id = BigInt(flag("id") ?? die("--id required"));
  const totalRaw = uiToRawGc(flag("total-ui") ?? die("--total-ui required"));
  const split = (flag("split") ?? "equal") as "equal" | "pro-rata";
  const expiryDays = Number(flag("expiry-days") ?? 30);
  if (expiryDays < 7 || expiryDays > 365) die("--expiry-days must be 7..365 (on-chain window)");
  const outDir = path.resolve(flag("out") ?? path.join(ROOT, "airdrops"));
  fs.mkdirSync(outDir, { recursive: true });
  const { gcMint, tokenProgram } = await gcMintAndProgram();
  const minRaw = flag("min-holding-ui")
    ? uiToRawGc(flag("min-holding-ui")!)
    : ((await readConfig().catch(() => null))?.airdropMinHolding ?? 0n);

  const now: Balances = flag("balances") ? JSON.parse(fs.readFileSync(flag("balances")!, "utf8")) : await liveBalances(gcMint, tokenProgram);
  if (!flag("balances")) fs.writeFileSync(path.join(outDir, `balances-${Date.now()}.json`), JSON.stringify(now, null, 2));
  const priors: Balances[] = (flag("prior") ?? "").split(",").filter(Boolean).map((f) => JSON.parse(fs.readFileSync(f, "utf8")));

  // BUGSWEEP-2026-10-07: the exclude list (team / burn / exchange wallets) is applied by default; forgetting
  // --exclude-file must not hand team wallets a share. Opt out explicitly with --no-exclude-file.
  const excludeFile = has("no-exclude-file") ? null : (flag("exclude-file") ?? DEFAULT_EXCLUDE_FILE);
  const excludeList = excludeFile ? [...parseExcludeList(JSON.parse(fs.readFileSync(excludeFile, "utf8"))).keys()] : [];
  if (excludeFile) console.log(`exclude list: ${excludeList.length} wallet(s) from ${path.relative(process.cwd(), excludeFile) || excludeFile}`);
  else console.log("exclude list: NONE (--no-exclude-file)");
  const treasuryOwners = new Set<string>([
    ...deriveAllTreasuryAddresses(PROGRAM_ID.toBase58()).pools.map((p) => p.pda),
    ...(flag("exclude") ?? "").split(",").filter(Boolean),
    ...excludeList,
  ]);
  const topN = flag("top") ? Number(flag("top")) : undefined;
  if (topN !== undefined && split !== "equal") die("--top is only defined for --split equal (launch airdrop Terms)");
  const eligible: { claimant: string; bal: bigint }[] = [];
  for (const [owner, raw] of Object.entries(now)) {
    let bal = BigInt(raw);
    for (const p of priors) bal = bal < BigInt(p[owner] ?? "0") ? bal : BigInt(p[owner] ?? "0");
    if (bal < minRaw || bal === 0n) continue;
    if (treasuryOwners.has(owner)) continue;
    if (!has("include-pdas") && !PublicKey.isOnCurve(new PublicKey(owner).toBytes())) continue;
    eligible.push({ claimant: owner, bal });
  }
  if (!eligible.length) die("no eligible holders");
  let selectionNote = "";
  if (topN !== undefined) {
    const sel = selectTopN(eligible.map((e) => ({ wallet: e.claimant, balanceRaw: e.bal })), topN, (flag("tie-break") ?? "error") as TieBreak);
    const keep = new Set(sel.selected.map((r) => r.wallet));
    selectionNote = `${sel.note}; cutoff balance ${sel.cutoffBalanceRaw} raw`;
    eligible.splice(0, eligible.length, ...eligible.filter((e) => keep.has(e.claimant)));
  }
  eligible.sort((a, b) => (a.claimant < b.claimant ? -1 : 1)); // deterministic order
  const sumBal = eligible.reduce((s, e) => s + e.bal, 0n);
  const share = split === "equal" ? equalSplit(totalRaw, eligible.length).shareRaw : 0n;
  const entries = eligible
    .map((e) => ({ claimant: e.claimant, amount: split === "equal" ? share : (totalRaw * e.bal) / sumBal }))
    .filter((e) => e.amount > 0n);
  const allocated = entries.reduce((s, e) => s + e.amount, 0n);

  const [dist] = deriveAirdropDistributionPda(id, PROGRAM_ID);
  const tree = buildMerkleTree(dist, entries);
  const claims = entries.map((e, i) => {
    const proof = tree.proof(i);
    if (!verifyMerkleProof(proof, tree.root, merkleLeaf(dist, i, new PublicKey(e.claimant), e.amount))) throw new Error("proof self-check failed");
    return { index: i, claimant: e.claimant, amountRaw: e.amount.toString(), proof: proof.map((p) => p.toString("hex")) };
  });
  const file = {
    version: 1 as const,
    programId: PROGRAM_ID.toBase58(),
    gcMint: gcMint.toBase58(),
    distributionId: id.toString(),
    distribution: dist.toBase58(),
    merkleRoot: tree.root.toString("hex"),
    totalAmountRaw: allocated.toString(),
    expiryTs: Math.floor(Date.now() / 1000) + Math.round(expiryDays * 86400),
    rules: { split, minHoldingRaw: minRaw.toString(), priorSnapshots: priors.length, excludedPdas: !has("include-pdas"), excludeFile: excludeFile ? path.basename(excludeFile) : null, excludeListSize: excludeList.length, ...(topN !== undefined ? { topN, rankedBy: "balance at snapshot", selection: selectionNote } : {}) },
    claims,
  };
  const out = path.join(outDir, `airdrop-${id}-proofs.json`);
  fs.writeFileSync(out, JSON.stringify(file, null, 2));
  if (selectionNote) console.log(`top-N: ${selectionNote}`);
  console.log(`eligible wallets: ${claims.length}${split === "equal" ? ` × ${share} raw each` : ""}\nallocated: ${allocated} raw (rounding dust ${totalRaw - allocated})\nroot: ${file.merkleRoot}\nproofs: ${out}`);
}

async function create(file: string) {
  const f = JSON.parse(fs.readFileSync(file, "utf8"));
  const authority = loadKeypair();
  const { gcMint, tokenProgram } = await gcMintAndProgram();
  if (f.gcMint !== gcMint.toBase58()) die("proofs file is for a different mint");
  const sig = await send([authority], [
    buildCreateAirdropIx({
      authority: authority.publicKey,
      gcMint,
      id: BigInt(f.distributionId),
      merkleRoot: Buffer.from(f.merkleRoot, "hex"),
      totalAmountRaw: BigInt(f.totalAmountRaw),
      expiryTs: BigInt(f.expiryTs),
      tokenProgramId: tokenProgram,
      programId: PROGRAM_ID,
    }),
  ]);
  console.log(`create_airdrop #${f.distributionId} ${sig}`);
}

async function main() {
  if (cmd === "snapshot") return snapshot();
  if (cmd === "create") return create(rest[0] ?? die("proofs file required"));
  if (cmd === "reclaim") {
    const sig = await send([loadKeypair()], [buildReclaimAirdropIx({ authority: loadKeypair().publicKey, distributionId: BigInt(rest[0] ?? die("id")), programId: PROGRAM_ID })]);
    return console.log(`reclaim_airdrop ${sig}`);
  }
  die("usage: airdrop.ts snapshot|create|reclaim (see header)");
}
main().catch((e) => die(String(e?.stack ?? e)));
