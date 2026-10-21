/**
 * Shared localnet harness for the e2e / security suites (audit round 2).
 *
 *  - spawns solana-test-validator OFFLINE with:
 *      greencat as an UPGRADEABLE program (upgrade authority = a fresh test keypair → GC-20 gate),
 *      ORAO VRF (tests/fixtures/orao_vrf.so, dumped from devnet) at its real program id,
 *      Metaplex Token Metadata (tests/fixtures/mpl_token_metadata.so, dumped from mainnet).
 *  - ORAO's documented localnet approach: init a *test* network (our own treasury + fulfillment
 *    authority) and emulate the off-chain fulfiller by signing the request seed (ed25519) and
 *    calling fulfill_v2. No real oracle, no real SOL.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import nacl from "tweetnacl";
import {
  GREENCAT_PROGRAM_ID,
  ORAO_VRF_PROGRAM_ID,
  TOKEN_METADATA_PROGRAM_ID,
  buildCreateCollectionNftIx,
  buildInitializeCollectionIx,
  INIT_COLLECTION_COMPUTE_UNITS,
  INIT_TREASURIES_COMPUTE_UNITS,
  buildInitializeTreasuriesIx,
  buildSetStakingEnabledIx,
  buildOraoFulfillIxs,
  buildOraoInitNetworkIx,
  decodeOraoRandomness,
  deriveOraoRandomnessPda,
  buildInitMintPoolIx,
  MINT_POOL_INIT_STEPS,
  SETTLE_MINT_COMPUTE_UNITS,
  decodeNftRecordAccount,
  deriveNftRecordPda,
  fetchRevealQueue,
  mintVrfSeed,
  settleIxsFromQueue,
} from "@greencat/sdk";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const PID = new PublicKey(GREENCAT_PROGRAM_ID);
export const SO_DEFAULT = path.join(ROOT, "target/deploy/greencat.so");
export const SO_SHORT = path.join(ROOT, "target/deploy/greencat-short.so");
const FIX = path.join(ROOT, "tests/fixtures");

export function assert(c: unknown, m: string): asserts c {
  if (!c) throw new Error(`ASSERT: ${m}`);
}

export async function waitRpc(conn: Connection, tries = 160) {
  for (let i = 0; i < tries; i++) {
    try {
      await conn.getLatestBlockhash();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error("validator RPC not ready");
}

export type Localnet = {
  conn: Connection;
  rpcUrl: string;
  /** greencat program upgrade authority (the only key allowed to initialize_treasuries). */
  upgradeAuthority: Keypair;
  stop: () => void;
};

/**
 * SIMD-0500 (disable deployment of SBPF v0–v2) is active by default on a test validator but still
 * inactive on Devnet/Mainnet (checked 2026-10-02). Our build is SBPF v0, so the upgrade rehearsal
 * deactivates it to match the real clusters.
 */
export const SIMD_0500_FEATURE = "B8JJXCy5amZyWG9r7EnUYLwzXSXTxG7GZ1qZ1qggo83g";

export async function startLocalnet(opts: { so?: string; port?: number; tag?: string; deactivateFeatures?: string[] } = {}): Promise<Localnet> {
  const so = opts.so ?? SO_DEFAULT;
  assert(fs.existsSync(so), `missing ${so} — run: anchor build --no-idl`);
  for (const f of ["orao_vrf.so", "mpl_token_metadata.so"]) {
    assert(fs.existsSync(path.join(FIX, f)), `missing tests/fixtures/${f}`);
  }
  const port = opts.port ?? 18899;
  const bin = process.env.SOLANA_BIN || path.join(os.homedir(), ".local/share/solana/install/active_release/bin");
  const ledger = fs.mkdtempSync(path.join(os.tmpdir(), `gc-${opts.tag ?? "ln"}-ledger-`));
  const upgradeAuthority = Keypair.generate();
  const validator: ChildProcess = spawn(
    path.join(bin, "solana-test-validator"),
    [
      "--ledger", ledger,
      "--rpc-port", String(port),
      "--faucet-port", String(port + 1001),
      "--gossip-port", String(port + 2),
      "--dynamic-port-range", `${port + 10}-${port + 40}`,
      "--upgradeable-program", PID.toBase58(), so, upgradeAuthority.publicKey.toBase58(),
      "--bpf-program", ORAO_VRF_PROGRAM_ID.toBase58(), path.join(FIX, "orao_vrf.so"),
      "--bpf-program", TOKEN_METADATA_PROGRAM_ID.toBase58(), path.join(FIX, "mpl_token_metadata.so"),
      ...(opts.deactivateFeatures ?? []).flatMap((f) => ["--deactivate-feature", f]),
      "--reset", "--quiet",
    ],
    { stdio: "ignore" }
  );
  const rpcUrl = `http://127.0.0.1:${port}`;
  const conn = new Connection(rpcUrl, "confirmed");
  const stop = () => {
    validator.kill("SIGTERM");
    fs.rmSync(ledger, { recursive: true, force: true });
  };
  try {
    await waitRpc(conn);
    assert(await conn.getAccountInfo(PID), "greencat not loaded");
    await airdrop(conn, upgradeAuthority.publicKey, 50);
  } catch (e) {
    stop();
    throw e;
  }
  console.log(`[localnet] validator ${rpcUrl} (${path.basename(so)})`);
  return { conn, rpcUrl, upgradeAuthority, stop };
}

export async function airdrop(conn: Connection, to: PublicKey, sol: number) {
  const sig = await conn.requestAirdrop(to, sol * LAMPORTS_PER_SOL);
  await conn.confirmTransaction(sig, "confirmed");
}

export async function sendIxs(
  conn: Connection,
  signers: Keypair[],
  ixs: TransactionInstruction[],
  cu?: number
): Promise<string> {
  const tx = new Transaction();
  if (cu) tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: cu }));
  tx.add(...ixs);
  return sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed", skipPreflight: false });
}

export type Orao = { treasury: PublicKey; fulfiller: Keypair; feeLamports: bigint };

/** Localnet: initialise a test ORAO network (treasury + single fulfillment authority). */
export async function initOrao(conn: Connection, payer: Keypair, feeLamports = 1_000_000n): Promise<Orao> {
  const treasury = Keypair.generate();
  const fulfiller = Keypair.generate();
  // treasury must stay rent-exempt when it receives fees
  await sendIxs(conn, [payer], [
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: treasury.publicKey, lamports: LAMPORTS_PER_SOL / 10 }),
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: fulfiller.publicKey, lamports: LAMPORTS_PER_SOL }),
  ]);
  await sendIxs(conn, [payer], [
    buildOraoInitNetworkIx({
      payer: payer.publicKey,
      treasury: treasury.publicKey,
      configAuthority: payer.publicKey,
      fulfillmentAuthorities: [fulfiller.publicKey],
      feeLamports,
    }),
  ]);
  return { treasury: treasury.publicKey, fulfiller, feeLamports };
}

/** Emulate the ORAO fulfiller for one request (seed). Returns the 64-byte randomness. */
export async function fulfillOrao(conn: Connection, orao: Orao, seed: Uint8Array): Promise<Buffer> {
  const reqPk = deriveOraoRandomnessPda(seed);
  const acc = await conn.getAccountInfo(reqPk);
  const dec = decodeOraoRandomness(acc?.data);
  assert(dec, `ORAO request ${reqPk.toBase58()} not found`);
  const signature = nacl.sign.detached(seed, orao.fulfiller.secretKey);
  await sendIxs(
    conn,
    [orao.fulfiller],
    buildOraoFulfillIxs({
      payer: orao.fulfiller.publicKey,
      seed,
      client: new PublicKey(dec.client),
      fulfillmentAuthority: orao.fulfiller.publicKey,
      signature,
    })
  );
  const after = decodeOraoRandomness((await conn.getAccountInfo(reqPk))?.data);
  assert(after?.randomness, "ORAO request not fulfilled");
  return after.randomness;
}

/**
 * Standard program init in the documented order (docs/HOSTING.md):
 * initialize_treasuries (upgrade authority) → initialize_collection → create_collection_nft → init_mint_pool.
 */
export async function initProgram(
  ln: Localnet,
  gcMint: PublicKey,
  tokenProgramId: PublicKey,
  opts: { collection?: boolean; metadataBaseUri?: string; staking?: "open" | "locked" } = {}
) {
  const a = ln.upgradeAuthority;
  await sendIxs(ln.conn, [a], [buildInitializeTreasuriesIx({ authority: a.publicKey, gcMint, tokenProgramId })], INIT_TREASURIES_COMPUTE_UNITS);
  // New deployments start with staking locked (mainnet launch rule); the suites that stake open it like the admin would.
  if (opts.staking !== "locked") await sendIxs(ln.conn, [a], [buildSetStakingEnabledIx({ authority: a.publicKey, enabled: true })]);
  if (opts.collection !== false) {
    await sendIxs(ln.conn, [a], [
      buildInitializeCollectionIx({ authority: a.publicKey, metadataBaseUri: opts.metadataBaseUri ?? "https://example.invalid/gc/" }),
    ], INIT_COLLECTION_COMPUTE_UNITS);
    await sendIxs(ln.conn, [a], [buildCreateCollectionNftIx({ authority: a.publicKey })], 400_000);
    await initMintPool(ln.conn, a);
  }
}

/** Permissionless init of the per-mint reveal pool (4 grow steps in one tx). */
export async function initMintPool(conn: Connection, payer: Keypair, programId = PID) {
  return sendIxs(conn, [payer], Array.from({ length: MINT_POOL_INIT_STEPS }, () => buildInitMintPoolIx({ payer: payer.publicKey, programId })), 200_000);
}

export type Settled = { mint: string; mintIndex: number; tokenId: number; rarity: number; randomness: Buffer };

/**
 * Emulate ORAO for every pending reveal request and settle the FIFO queue head-first until it is empty
 * (or blocked by an unrequested legacy entry). Returns what was revealed, in order.
 */
export async function settleQueue(conn: Connection, orao: Orao, cranker: Keypair, programId = PID): Promise<Settled[]> {
  const out: Settled[] = [];
  for (;;) {
    const q = await fetchRevealQueue(conn, programId);
    const rand = new Map<string, Buffer>();
    for (const e of q.entries) {
      if (!e.nftMint) break;
      const seed = mintVrfSeed(new PublicKey(e.nftMint), e.attempt, programId);
      if (!e.fulfilled) {
        e.fulfilled = true;
        rand.set(e.nftMint, await fulfillOrao(conn, orao, seed));
      } else {
        rand.set(e.nftMint, decodeOraoRandomness((await conn.getAccountInfo(deriveOraoRandomnessPda(seed)))?.data)!.randomness!);
      }
    }
    const ixs = settleIxsFromQueue(q, programId, { max: 3 });
    if (!ixs.length) return out;
    await sendIxs(conn, [cranker], ixs, SETTLE_MINT_COMPUTE_UNITS * ixs.length);
    for (const ix of ixs) {
      const m = ix.keys[3].pubkey;
      const rec = decodeNftRecordAccount(Buffer.from((await conn.getAccountInfo(deriveNftRecordPda(m, programId)[0]))!.data))!;
      out.push({ mint: m.toBase58(), mintIndex: rec.mintIndex, tokenId: rec.tokenId, rarity: rec.rarity, randomness: rand.get(m.toBase58())! });
    }
  }
}

/** Extract the Anchor custom error name/number from a failed send. */
export function errText(e: unknown): string {
  const anyE = e as { logs?: string[]; transactionLogs?: string[]; message?: string };
  const logs = anyE.logs ?? anyE.transactionLogs ?? [];
  return `${anyE.message ?? String(e)}\n${logs.join("\n")}`;
}

export async function expectFail(p: Promise<unknown>, needle: string | RegExp, label: string): Promise<string> {
  try {
    await p;
  } catch (e) {
    const t = errText(e);
    const ok = typeof needle === "string" ? t.includes(needle) : needle.test(t);
    if (!ok) throw new Error(`[${label}] failed but not with ${String(needle)}:\n${t.slice(0, 3000)}`);
    return t;
  }
  throw new Error(`[${label}] expected failure (${String(needle)}) but tx succeeded`);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type ParsedMetadata = {
  updateAuthority: string;
  mint: string;
  name: string;
  symbol: string;
  uri: string;
  sellerFeeBasisPoints: number;
  creators: { address: string; verified: boolean; share: number }[];
  isMutable: boolean;
  collection: { verified: boolean; key: string } | null;
};

/** Minimal Metaplex Token Metadata (v1.x) account parser — enough for the audit assertions. */
export function parseMetadata(d: Buffer): ParsedMetadata {
  let o = 1;
  const pk = () => {
    const v = new PublicKey(d.subarray(o, o + 32)).toBase58();
    o += 32;
    return v;
  };
  const str = () => {
    const n = d.readUInt32LE(o);
    o += 4;
    const v = d.subarray(o, o + n).toString("utf8").replace(/\0+$/, "");
    o += n;
    return v;
  };
  const updateAuthority = pk();
  const mint = pk();
  const name = str();
  const symbol = str();
  const uri = str();
  const sellerFeeBasisPoints = d.readUInt16LE(o);
  o += 2;
  const creators: ParsedMetadata["creators"] = [];
  if (d[o++] === 1) {
    const n = d.readUInt32LE(o);
    o += 4;
    for (let i = 0; i < n; i++) {
      const address = pk();
      creators.push({ address, verified: d[o++] === 1, share: d[o++] });
    }
  }
  o += 1; // primary_sale_happened
  const isMutable = d[o++] === 1;
  if (d[o++] === 1) o += 1; // edition_nonce
  if (d[o++] === 1) o += 1; // token_standard
  let collection: ParsedMetadata["collection"] = null;
  if (d[o++] === 1) {
    const verified = d[o++] === 1;
    collection = { verified, key: pk() };
  }
  return { updateAuthority, mint, name, symbol, uri, sellerFeeBasisPoints, creators, isMutable, collection };
}
