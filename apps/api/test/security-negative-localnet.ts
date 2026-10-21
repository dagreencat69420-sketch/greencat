/**
 * Security negative suite (audit rounds 1 + 2). Every fixed finding has an attack here that
 * MUST fail against the current build, plus liveness checks that safe paths still work.
 *
 *   npm run test:security --workspace=@greencat/api                   # $GC = Token-2022 (mainnet parity)
 *   GC_TOKEN=spl npm run test:security --workspace=@greencat/api      # $GC = classic SPL (devnet parity)
 *
 * Phase "main"  — target/deploy/greencat.so (production windows: VRF expiry ≥ 1 h, airdrop ≥ 7 d).
 * Phase "short" — target/deploy/greencat-short.so (`--features localnet-short-windows`: expiry ≥ 2 s,
 *                 airdrop ≥ 2 s, reclaim grace 1 s) for the time-dependent refund / re-request /
 *                 reclaim paths. Same code otherwise.
 * Fully offline: ORAO VRF + Token Metadata are loaded from tests/fixtures; ORAO fulfilment is
 * emulated with a test network (ORAO's documented localnet approach). No real SOL.
 *
 * Round-1 "EXPECT=vulnerable" mode (pre-fix binaries) is retired: the round-2 instruction set is
 * not ABI-compatible with the old binaries. The round-1 artifacts (target/security-negative-*.json
 * in /workspace/greencat-audit-artifacts) remain the proof those exploits worked pre-fix.
 *
 * Env: PHASE=main|short|all (default all), ONLY=GC-01,GC-15a (subset), SECURITY_SO, E2E_RPC_PORT.
 */
import {
  ComputeBudgetProgram,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SendTransactionError,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  type Connection,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAccount,
  createAssociatedTokenAccountIdempotent,
  createMint,
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  mintTo,
} from "@solana/spl-token";
import fs from "node:fs";
import path from "node:path";
import {
  PoolId,
  TOKEN_METADATA_PROGRAM_ID,
  buildAcceptAuthorityIx,
  buildAcceptOfferIx,
  buildBuyNftIx,
  buildCancelListingIx,
  buildCancelOfferIx,
  buildClaimAirdropIx,
  buildClaimLongIx,
  buildCloseMintIx,
  buildCreateAirdropIx,
  buildCreateCollectionNftIx,
  buildDepositTreasuryIx,
  buildInitMintPoolIx,
  buildInitializeCollectionIx,
  buildInitializeTreasuriesIx,
  buildListNftIx,
  buildMakeOfferIx,
  buildMintNftIx,
  buildProposeAuthorityIx,
  buildReclaimAirdropIx,
  buildRequestMintVrfIx,
  buildSettleMintIx,
  buildSetPausedIx,
  buildSetRoyaltyIx,
  buildSetStakingEnabledIx,
  buildAddDailyIx,
  buildClaimDailyIx,
  buildSetVrfExpiryIx,
  buildStakeDailyIx,
  buildStakeLongIx,
  buildUnstakeDailyIx,
  buildWithdrawTreasuryIx,
  buildMerkleTree,
  decodeCollectionAccount,
  decodeConfigAccount,
  deriveAirdropDistributionPda,
  deriveCollectionPda,
  deriveConfigPda,
  deriveDailyStakePda,
  deriveLongTranchePda,
  deriveMetadataPda,
  deriveNftAuthorityPda,
  deriveOfferPda,
  deriveTreasuryPda,
  deriveTreasuryVaultAta,
  mintVrfSeed,
  fetchRevealQueue,
  poolIndexFromRandomness,
  poolTake,
  decodeNftRecordAccount,
  deriveNftRecordPda,
  getTokenRarity,
  rarityToU8,
  decodeOraoRandomness,
  deriveOraoRandomnessPda,
  INIT_COLLECTION_COMPUTE_UNITS,
} from "@greencat/sdk";
import {
  PID,
  ROOT,
  SO_DEFAULT,
  SO_SHORT,
  fulfillOrao,
  initMintPool,
  initOrao,
  parseMetadata,
  settleQueue,
  sleep,
  startLocalnet,
  type Localnet,
  type Orao,
} from "./localnet";

const TOKEN = process.env.GC_TOKEN === "spl" ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;
const TOKEN_NAME = TOKEN.equals(TOKEN_PROGRAM_ID) ? "spl" : "token2022";
const ONLY = (process.env.ONLY || "").split(",").map((s) => s.trim()).filter(Boolean);
const PHASE = process.env.PHASE || "all";
const UI = 1_000_000n;
const want = (id: string) => ONLY.length === 0 || ONLY.some((o) => id === o || id.startsWith(o));

type Result = { phase: string; id: string; title: string; ok: boolean; note: string };
const results: Result[] = [];

type User = { kp: Keypair; ata: PublicKey };

/** Per-validator context. */
class Ctx {
  conn: Connection;
  admin: Keypair;
  gcMint!: PublicKey;
  adminAta!: PublicKey;
  orao!: Orao;
  constructor(public ln: Localnet, public phase: string) {
    this.conn = ln.conn;
    this.admin = ln.upgradeAuthority;
  }

  async send(ixs: TransactionInstruction[], signers: Keypair[]) {
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...ixs);
    return sendAndConfirmTransaction(this.conn, tx, signers, { commitment: "confirmed" });
  }

  /** null on success, else message + program logs */
  async trySend(ixs: TransactionInstruction[], signers: Keypair[]): Promise<string | null> {
    try {
      await this.send(ixs, signers);
      return null;
    } catch (e) {
      let logs: string[] = [];
      if (e instanceof SendTransactionError) {
        try {
          logs = (await e.getLogs(this.conn)) ?? [];
        } catch {
          logs = e.logs ?? [];
        }
      }
      return [String((e as Error).message), ...logs].join("\n");
    }
  }

  pool(id: PoolId) {
    const [pda] = deriveTreasuryPda(id, PID);
    return { pda, vault: deriveTreasuryVaultAta(this.gcMint, pda, TOKEN) };
  }

  async newUser(gcUi = 0n): Promise<User> {
    const kp = Keypair.generate();
    await this.conn.confirmTransaction(await this.conn.requestAirdrop(kp.publicKey, 50 * LAMPORTS_PER_SOL), "confirmed");
    const ata = await createAssociatedTokenAccountIdempotent(this.conn, this.admin, this.gcMint, kp.publicKey, { commitment: "confirmed" }, TOKEN);
    if (gcUi > 0n) await mintTo(this.conn, this.admin, this.gcMint, ata, this.admin, gcUi * UI, [], { commitment: "confirmed" }, TOKEN);
    return { kp, ata };
  }

  async bal(ata: PublicKey, program = TOKEN): Promise<bigint> {
    return (await getAccount(this.conn, ata, "confirmed", program)).amount;
  }

  async config() {
    return decodeConfigAccount((await this.conn.getAccountInfo(deriveConfigPda(PID)[0], "confirmed"))!.data)!;
  }

  async deposit(pool: PoolId, amountUi: bigint) {
    await this.send(
      [buildDepositTreasuryIx({ depositor: this.admin.publicKey, depositorAta: this.adminAta, gcMint: this.gcMint, poolId: pool, amountRaw: amountUi * UI, tokenProgramId: TOKEN })],
      [this.admin]
    );
  }

  mintIx(owner: User, nftMint: PublicKey) {
    return buildMintNftIx({
      buyer: owner.kp.publicKey,
      nftMint,
      gcMint: this.gcMint,
      buyerGcAta: owner.ata,
      buyerNftAta: getAssociatedTokenAddressSync(nftMint, owner.kp.publicKey, false, TOKEN_PROGRAM_ID),
      vrfTreasury: this.orao.treasury,
      tokenProgramId: TOKEN,
    });
  }

  async mintNft(owner: User) {
    const nft = Keypair.generate();
    await this.send([this.mintIx(owner, nft.publicKey)], [owner.kp, nft]);
    return { mint: nft.publicKey, ata: getAssociatedTokenAddressSync(nft.publicKey, owner.kp.publicKey, false, TOKEN_PROGRAM_ID) };
  }

  async listFor(seller: User, priceUi: bigint) {
    const nft = await this.mintNft(seller);
    await this.send([buildListNftIx({ seller: seller.kp.publicKey, nftMint: nft.mint, sellerNftAta: nft.ata, priceRaw: priceUi * UI })], [seller.kp]);
    return nft;
  }

  buyIx(buyer: User, seller: User, nftMint: PublicKey, expectedUi: bigint) {
    return buildBuyNftIx({
      buyer: buyer.kp.publicKey,
      seller: seller.kp.publicKey,
      nftMint,
      gcMint: this.gcMint,
      buyerGcAta: buyer.ata,
      sellerGcAta: seller.ata,
      buyerNftAta: getAssociatedTokenAddressSync(nftMint, buyer.kp.publicKey, false, TOKEN_PROGRAM_ID),
      expectedPriceRaw: expectedUi * UI,
      tokenProgramId: TOKEN,
    });
  }

  acceptIx(owner: User, bidder: User, nft: { mint: PublicKey; ata: PublicKey }, minUi: bigint) {
    return buildAcceptOfferIx({
      owner: owner.kp.publicKey,
      bidder: bidder.kp.publicKey,
      nftMint: nft.mint,
      gcMint: this.gcMint,
      ownerGcAta: owner.ata,
      ownerNftAta: nft.ata,
      bidderNftAta: getAssociatedTokenAddressSync(nft.mint, bidder.kp.publicKey, false, TOKEN_PROGRAM_ID),
      minAmountRaw: minUi * UI,
      tokenProgramId: TOKEN,
    });
  }

  offerIx(bidder: User, nftMint: PublicKey, amountUi: bigint) {
    return buildMakeOfferIx({ bidder: bidder.kp.publicKey, nftMint, gcMint: this.gcMint, bidderGcAta: bidder.ata, amountRaw: amountUi * UI, tokenProgramId: TOKEN });
  }

  /** Run one case: `attack` returns null (tx succeeded) or logs. */
  async rejects(id: string, title: string, expectError: string | RegExp, attack: () => Promise<string | null>, after?: () => Promise<string | void>) {
    if (!want(id)) return;
    let ok = false;
    let note = "";
    try {
      const logs = await attack();
      const match = (l: string) => (typeof expectError === "string" ? l.includes(expectError) : expectError.test(l));
      if (logs === null) note = "ATTACK SUCCEEDED (regression!)";
      else if (match(logs)) {
        ok = true;
        const code = /Error Code: (\w+)/.exec(logs)?.[1] ?? /already in use/.exec(logs)?.[0] ?? /custom program error: 0x\w+/.exec(logs)?.[0];
        note = `rejected with ${code ?? String(expectError)}`;
        if (after) {
          const extra = await after();
          if (extra) note += `; ${extra}`;
        }
      } else note = `failed but without ${String(expectError)}: ${logs.slice(0, 900)}`;
    } catch (e) {
      note = `harness error: ${(e as Error).message}`;
    }
    this.record(id, title, ok, note);
  }

  /** Liveness: must succeed. `run` throws on failure. */
  async works(id: string, title: string, run: () => Promise<string>) {
    if (!want(id)) return;
    let ok = false;
    let note = "";
    try {
      note = await run();
      ok = true;
    } catch (e) {
      note = `FAILED: ${(e as Error).message.slice(0, 1200)}`;
    }
    this.record(id, title, ok, note);
  }

  record(id: string, title: string, ok: boolean, note: string) {
    results.push({ phase: this.phase, id, title, ok, note });
    console.log(`${ok ? "PASS" : "FAIL"} [${this.phase}] ${id} ${title}\n      → ${note}`);
  }
}

function swapKey(ix: TransactionInstruction, index: number, pk: PublicKey) {
  ix.keys[index] = { ...ix.keys[index], pubkey: pk };
  return ix;
}

function mustOk(logs: string | null, what: string) {
  if (logs !== null) throw new Error(`${what}: ${logs.slice(0, 900)}`);
}

/** Metaplex UpdateMetadataAccountV2 (discriminator 15): data=None, new_update_authority=Some(pk). */
function mplUpdateAuthorityIx(metadata: PublicKey, signer: PublicKey, newAuthority: PublicKey) {
  const data = Buffer.concat([Buffer.from([15, 0, 1]), newAuthority.toBuffer(), Buffer.from([0, 0])]);
  return new TransactionInstruction({
    programId: TOKEN_METADATA_PROGRAM_ID,
    keys: [
      { pubkey: metadata, isSigner: false, isWritable: true },
      { pubkey: signer, isSigner: true, isWritable: false },
    ],
    data,
  });
}

async function setupBase(c: Ctx) {
  c.orao = await initOrao(c.conn, c.admin);
  c.gcMint = await createMint(c.conn, c.admin, c.admin.publicKey, null, 6, Keypair.generate(), { commitment: "confirmed" }, TOKEN);
  c.adminAta = await createAssociatedTokenAccountIdempotent(c.conn, c.admin, c.gcMint, c.admin.publicKey, { commitment: "confirmed" }, TOKEN);
  await mintTo(c.conn, c.admin, c.gcMint, c.adminAta, c.admin, 2_000_000_000n * UI, [], { commitment: "confirmed" }, TOKEN);
}

async function initAll(c: Ctx) {
  await c.send([buildInitializeTreasuriesIx({ authority: c.admin.publicKey, gcMint: c.gcMint, tokenProgramId: TOKEN })], [c.admin]);
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: INIT_COLLECTION_COMPUTE_UNITS }),
    buildInitializeCollectionIx({ authority: c.admin.publicKey, metadataBaseUri: "https://example.invalid/nft/" })
  );
  await sendAndConfirmTransaction(c.conn, tx, [c.admin], { commitment: "confirmed" });
  await initMintPool(c.conn, c.admin);
}

// ═════════════════════════════════════════════════════════════════════════════
// Phase main
// ═════════════════════════════════════════════════════════════════════════════
async function phaseMain(c: Ctx) {
  await setupBase(c);
  const conn = c.conn;
  const admin = c.admin;

  // ── GC-20: only the upgrade authority can initialize ──
  const intruder = await (async () => {
    const kp = Keypair.generate();
    await conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, 10 * LAMPORTS_PER_SOL), "confirmed");
    return kp;
  })();
  await c.rejects("GC-20a", "initialize_treasuries by a non-upgrade-authority (front-run init with attacker mint/authority)", "NotUpgradeAuthority", () =>
    c.trySend([buildInitializeTreasuriesIx({ authority: intruder.publicKey, gcMint: c.gcMint, tokenProgramId: TOKEN })], [intruder])
  );
  await c.rejects("GC-20b", "initialize_treasuries with a forged program_data account", /ConstraintSeeds|ConstraintAddress|InvalidProgramExecutable|AccountOwnedByWrongProgram|AccountDiscriminator|NotUpgradeAuthority|InstructionFallbackNotFound|AccountNotProgramData|2003|2006|3007/, () => {
    const ix = buildInitializeTreasuriesIx({ authority: intruder.publicKey, gcMint: c.gcMint, tokenProgramId: TOKEN });
    swapKey(ix, ix.keys.length - 1, intruder.publicKey);
    return c.trySend([ix], [intruder]);
  });

  // ── GC-12: init with a token program that does not own the mint ──
  await c.rejects("GC-12", "initialize_treasuries with mint/token_program mismatch (would brick Config)", /ConstraintMintTokenProgram|ConstraintTokenProgram|AccountOwnedByWrongProgram|IncorrectProgramId|MintMismatch/, async () => {
    for (const id of [0, 1, 2, 3, 4, 5] as PoolId[]) {
      await createAssociatedTokenAccountIdempotent(conn, admin, c.gcMint, c.pool(id).pda, { commitment: "confirmed" }, TOKEN, undefined, true);
    }
    const ix = buildInitializeTreasuriesIx({ authority: admin.publicKey, gcMint: c.gcMint, tokenProgramId: TOKEN });
    swapKey(ix, ix.keys.length - 5, TOKEN.equals(TOKEN_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID);
    return c.trySend([ix], [admin]);
  });

  await initAll(c);
  console.log("[security] treasuries (by upgrade authority) + collection initialized");

  // ── Staking switch: a fresh deployment starts LOCKED; only the admin opens it ──
  {
    const early = await c.newUser(10_000n);
    await c.works("SL-a", "fresh deployment: Config.staking_enabled = false (flag set) → staking locked", async () => {
      const cfg = await c.config();
      if (cfg.stakingEnabled || !cfg.stakingFlagSet) throw new Error(`staking ${JSON.stringify({ e: cfg.stakingEnabledRaw, f: cfg.stakingFlagSet })}`);
      return "locked by default";
    });
    await c.rejects("SL-b", "stake_daily while staking is locked", "StakingLocked", () =>
      c.trySend([buildStakeDailyIx({ staker: early.kp.publicKey, gcMint: c.gcMint, stakerAta: early.ata, amountRaw: 1_000n * UI, tokenProgramId: TOKEN })], [early.kp])
    );
    await c.rejects("SL-c", "stake_long (365-day) while staking is locked", "StakingLocked", () =>
      c.trySend([buildStakeLongIx({ staker: early.kp.publicKey, gcMint: c.gcMint, stakerAta: early.ata, amountRaw: 1_000n * UI, trancheId: 0, tokenProgramId: TOKEN })], [early.kp])
    );
    await c.rejects("SL-d", "set_staking_enabled(true) by a non-admin", "Unauthorized", () =>
      c.trySend([buildSetStakingEnabledIx({ authority: early.kp.publicKey, enabled: true })], [early.kp])
    );
    await c.works("SL-e", "admin set_staking_enabled(true) → stake_daily works", async () => {
      await c.send([buildSetStakingEnabledIx({ authority: admin.publicKey, enabled: true })], [admin]);
      const cfg = await c.config();
      if (!cfg.stakingEnabled) throw new Error("still locked");
      await c.send([buildStakeDailyIx({ staker: early.kp.publicKey, gcMint: c.gcMint, stakerAta: early.ata, amountRaw: 1_000n * UI, tokenProgramId: TOKEN })], [early.kp]);
      return "open; stake_daily ok";
    });
  }

  // ── GC-18: collection NFT + royalty config before mint ──
  await c.rejects("GC-18a", "mint_nft before the verified collection NFT exists", "CollectionNftMissing", async () => {
    const u = await c.newUser(20_000n);
    const nft = Keypair.generate();
    return c.trySend([c.mintIx(u, nft.publicKey)], [u.kp, nft]);
  });
  await c.rejects("GC-18b", "non-admin create_collection_nft", /Unauthorized|ConstraintHasOne|2001/, () =>
    c.trySend([buildCreateCollectionNftIx({ authority: intruder.publicKey })], [intruder])
  );
  await c.send([buildCreateCollectionNftIx({ authority: admin.publicKey })], [admin]);
  await c.rejects("GC-18c", "create_collection_nft twice", /CollectionNftExists|already in use/, () =>
    c.trySend([buildCreateCollectionNftIx({ authority: admin.publicKey })], [admin])
  );
  const [feeTreasury] = deriveTreasuryPda(PoolId.NftFeeTreasury, PID);
  await c.rejects("GC-18d", "set_royalty above the 10% hard max", "RoyaltyTooHigh", () =>
    c.trySend([buildSetRoyaltyIx({ authority: admin.publicKey, royaltyBps: 1001, recipient: feeTreasury })], [admin])
  );
  await c.rejects("GC-18e", "non-admin set_royalty (redirect royalties)", /Unauthorized|ConstraintHasOne|2001/, () =>
    c.trySend([buildSetRoyaltyIx({ authority: intruder.publicKey, royaltyBps: 500, recipient: intruder.publicKey })], [intruder])
  );
  await c.works("GC-18f", "admin can change royalty before the first mint (and restore 500 bps → fee treasury)", async () => {
    await c.send([buildSetRoyaltyIx({ authority: admin.publicKey, royaltyBps: 750, recipient: admin.publicKey })], [admin]);
    let col = decodeCollectionAccount((await conn.getAccountInfo(deriveCollectionPda(PID)[0]))!.data)!;
    if (col.royaltyBps !== 750) throw new Error("not applied");
    await c.send([buildSetRoyaltyIx({ authority: admin.publicKey, royaltyBps: 500, recipient: feeTreasury })], [admin]);
    col = decodeCollectionAccount((await conn.getAccountInfo(deriveCollectionPda(PID)[0]))!.data)!;
    return `750 bps applied then restored to ${col.royaltyBps} bps → ${col.royaltyRecipient.slice(0, 6)}… (fee treasury PDA)`;
  });

  // ── round-1 fixes (regression) ──
  {
    let attacker: User;
    let before = 0n;
    let proceedsBefore = 0n;
    await c.rejects("GC-01", "mint_nft paying into attacker's own account instead of mint_proceeds (free mint)", "InvalidProceedsVault", async () => {
      attacker = await c.newUser(20_000n);
      before = await c.bal(attacker.ata);
      proceedsBefore = await c.bal(c.pool(PoolId.MintProceeds).vault);
      const nft = Keypair.generate();
      return c.trySend([swapKey(c.mintIx(attacker, nft.publicKey), 6, attacker.ata)], [attacker.kp, nft]);
    }, async () => {
      if ((await c.bal(attacker.ata)) !== before || (await c.bal(c.pool(PoolId.MintProceeds).vault)) !== proceedsBefore) throw new Error("balances moved");
    });
  }
  await c.rejects("GC-02", "stake_daily with attacker-owned 'principal vault' (phantom principal)", "InvalidPrincipalVault", async () => {
    const a = await c.newUser(1_000_000n);
    const side = await createAccount(conn, a.kp, c.gcMint, a.kp.publicKey, Keypair.generate(), { commitment: "confirmed" }, TOKEN);
    return c.trySend([swapKey(buildStakeDailyIx({ staker: a.kp.publicKey, gcMint: c.gcMint, stakerAta: a.ata, amountRaw: 1_000_000n * UI, tokenProgramId: TOKEN }), 5, side)], [a.kp]);
  });
  await c.rejects("GC-03", "stake_long with attacker-owned 'principal vault' (phantom tranche)", "InvalidPrincipalVault", async () => {
    const a = await c.newUser(1_000_000n);
    const side = await createAccount(conn, a.kp, c.gcMint, a.kp.publicKey, Keypair.generate(), { commitment: "confirmed" }, TOKEN);
    return c.trySend([swapKey(buildStakeLongIx({ staker: a.kp.publicKey, gcMint: c.gcMint, stakerAta: a.ata, amountRaw: 500_000n * UI, trancheId: 0, tokenProgramId: TOKEN }), 6, side)], [a.kp]);
  });
  await c.rejects("GC-04", "buy_nft with seller_gc_ata = buyer's own account (steal listed NFT)", "InvalidPayoutAccount", async () => {
    const seller = await c.newUser(50_000n);
    const buyer = await c.newUser(50_000n);
    const nft = await c.listFor(seller, 5_000n);
    const ix = c.buyIx(buyer, seller, nft.mint, 5_000n);
    swapKey(ix, ix.keys.findIndex((k) => k.pubkey.equals(seller.ata)), buyer.ata); // seller_gc_ata := buyer's own ATA
    return c.trySend([ix], [buyer.kp]);
  });
  await c.rejects("GC-06", "buy_nft with nft_fee_treasury_vault = buyer's own account (fee evasion)", "InvalidFeeVault", async () => {
    const seller = await c.newUser(50_000n);
    const buyer = await c.newUser(50_000n);
    const nft = await c.listFor(seller, 5_000n);
    return c.trySend([swapKey(c.buyIx(buyer, seller, nft.mint, 5_000n), 11, buyer.ata)], [buyer.kp]);
  });
  await c.rejects("GC-05", "accept_offer delivering a junk token instead of the NFT", "InvalidPayoutAccount", async () => {
    const owner = await c.newUser(50_000n);
    const bidder = await c.newUser(50_000n);
    const nft = await c.mintNft(owner);
    await c.send([c.offerIx(bidder, nft.mint, 20_000n)], [bidder.kp]);
    const junk = await createMint(conn, owner.kp, owner.kp.publicKey, null, 0, Keypair.generate(), { commitment: "confirmed" }, TOKEN_PROGRAM_ID);
    const ownerJunk = await createAssociatedTokenAccountIdempotent(conn, owner.kp, junk, owner.kp.publicKey, { commitment: "confirmed" }, TOKEN_PROGRAM_ID);
    await mintTo(conn, owner.kp, junk, ownerJunk, owner.kp, 1n, [], { commitment: "confirmed" }, TOKEN_PROGRAM_ID);
    const sink = await createAccount(conn, owner.kp, junk, owner.kp.publicKey, Keypair.generate(), { commitment: "confirmed" }, TOKEN_PROGRAM_ID);
    const ix = c.acceptIx(owner, bidder, { mint: nft.mint, ata: ownerJunk }, 20_000n);
    const bidderNftAta = getAssociatedTokenAddressSync(nft.mint, bidder.kp.publicKey, false, TOKEN_PROGRAM_ID);
    swapKey(ix, ix.keys.findIndex((k) => k.pubkey.equals(bidderNftAta)), sink); // deliver junk into owner's own sink
    return c.trySend([ix], [owner.kp]);
  });
  await c.rejects("GC-08", "list_nft of a look-alike token not minted by the program", /AccountNotInitialized|3012/, async () => {
    const s = await c.newUser(0n);
    const fake = await createMint(conn, s.kp, s.kp.publicKey, null, 0, Keypair.generate(), { commitment: "confirmed" }, TOKEN_PROGRAM_ID);
    const fakeAta = await createAssociatedTokenAccountIdempotent(conn, s.kp, fake, s.kp.publicKey, { commitment: "confirmed" }, TOKEN_PROGRAM_ID);
    await mintTo(conn, s.kp, fake, fakeAta, s.kp, 1n, [], { commitment: "confirmed" }, TOKEN_PROGRAM_ID);
    return c.trySend([buildListNftIx({ seller: s.kp.publicKey, nftMint: fake, sellerNftAta: fakeAta, priceRaw: 1n * UI })], [s.kp]);
  });
  await c.rejects("GC-07a", "list_nft escrowing into a seller-controlled account", "InvalidEscrow", async () => {
    const s = await c.newUser(20_000n);
    const nft = await c.mintNft(s);
    const side = await createAccount(conn, s.kp, nft.mint, s.kp.publicKey, Keypair.generate(), { commitment: "confirmed" }, TOKEN_PROGRAM_ID);
    return c.trySend([swapKey(buildListNftIx({ seller: s.kp.publicKey, nftMint: nft.mint, sellerNftAta: nft.ata, priceRaw: 1n * UI }), 5, side)], [s.kp]);
  });
  await c.rejects("GC-07b", "make_offer 'escrowing' into the bidder's own account", "InvalidEscrow", async () => {
    const o = await c.newUser(20_000n);
    const nft = await c.mintNft(o);
    const b = await c.newUser(50_000n);
    const side = await createAccount(conn, b.kp, c.gcMint, b.kp.publicKey, Keypair.generate(), { commitment: "confirmed" }, TOKEN);
    return c.trySend([swapKey(c.offerIx(b, nft.mint, 1_000n), 7, side)], [b.kp]);
  });
  await c.works("GC-10", "accept_offer with an Offer account posing as the Listing is ignored (decoy untouched)", async () => {
    const owner = await c.newUser(50_000n);
    const bidder = await c.newUser(50_000n);
    const nft = await c.mintNft(owner);
    await c.send([c.offerIx(owner, nft.mint, 1n)], [owner.kp]);
    await c.send([c.offerIx(bidder, nft.mint, 1_000n)], [bidder.kp]);
    const [decoy] = deriveOfferPda(nft.mint, owner.kp.publicKey, PID);
    mustOk(await c.trySend([swapKey(c.acceptIx(owner, bidder, nft, 1_000n), 12, decoy)], [owner.kp]), "accept");
    const still = await conn.getAccountInfo(decoy, "confirmed");
    if (!still || !still.owner.equals(PID)) throw new Error("decoy closed");
    return "decoy ignored; normal wallet path used";
  });
  await c.works("GC-16", "cancel_offer refunds the escrowed bid (Token-2022 close_account liveness)", async () => {
    const owner = await c.newUser(20_000n);
    const nft = await c.mintNft(owner);
    const b = await c.newUser(5_000n);
    const before = await c.bal(b.ata);
    await c.send([c.offerIx(b, nft.mint, 1_000n)], [b.kp]);
    await c.send([buildCancelOfferIx({ bidder: b.kp.publicKey, nftMint: nft.mint, gcMint: c.gcMint, bidderGcAta: b.ata, tokenProgramId: TOKEN })], [b.kp]);
    if ((await c.bal(b.ata)) !== before) throw new Error("refund mismatch");
    return "bid fully refunded";
  });

  // ── GC-21: slippage guards ──
  await c.rejects("GC-21a", "buy_nft when the listing price differs from expected_price (seller re-list front-run)", "PriceMismatch", async () => {
    const seller = await c.newUser(50_000n);
    const buyer = await c.newUser(50_000n);
    const nft = await c.listFor(seller, 1_000n);
    // seller front-runs: cancel + re-list at 5× while the buyer's tx expects 1,000
    await c.send([buildCancelListingIx({ seller: seller.kp.publicKey, nftMint: nft.mint, sellerNftAta: nft.ata })], [seller.kp]);
    await c.send([buildListNftIx({ seller: seller.kp.publicKey, nftMint: nft.mint, sellerNftAta: nft.ata, priceRaw: 5_000n * UI })], [seller.kp]);
    return c.trySend([c.buyIx(buyer, seller, nft.mint, 1_000n)], [buyer.kp]);
  });
  await c.rejects("GC-21b", "accept_offer after the bidder swapped in a lower offer (min_amount guard)", "OfferBelowMinimum", async () => {
    const owner = await c.newUser(20_000n);
    const bidder = await c.newUser(50_000n);
    const nft = await c.mintNft(owner);
    await c.send([c.offerIx(bidder, nft.mint, 20_000n)], [bidder.kp]);
    await c.send([buildCancelOfferIx({ bidder: bidder.kp.publicKey, nftMint: nft.mint, gcMint: c.gcMint, bidderGcAta: bidder.ata, tokenProgramId: TOKEN })], [bidder.kp]);
    await c.send([c.offerIx(bidder, nft.mint, 1n)], [bidder.kp]);
    return c.trySend([c.acceptIx(owner, bidder, nft, 20_000n)], [owner.kp]);
  });

  // ── GC-18: holder metadata rewrite + royalty lock after mint ──
  {
    let holderNft: { mint: PublicKey; ata: PublicKey };
    let holder: User;
    await c.rejects("GC-18g", "NFT holder tries to take metadata update authority (rewrite name/URI/attributes)", /custom program error|Update Authority|IncorrectOwner|0x7|0x29|0x39|InvalidUpdateAuthority/, async () => {
      holder = await c.newUser(20_000n);
      holderNft = await c.mintNft(holder);
      return c.trySend([mplUpdateAuthorityIx(deriveMetadataPda(holderNft.mint)[0], holder.kp.publicKey, holder.kp.publicKey)], [holder.kp]);
    }, async () => {
      const md = parseMetadata((await conn.getAccountInfo(deriveMetadataPda(holderNft.mint)[0]))!.data);
      if (md.updateAuthority !== deriveNftAuthorityPda(PID)[0].toBase58()) throw new Error("update authority changed!");
      if (!md.collection?.verified) throw new Error("collection not verified");
      return `update authority still the program PDA; collection verified; ${md.sellerFeeBasisPoints} bps`;
    });
    await c.rejects("GC-18h", "set_royalty after the first mint", "RoyaltyLocked", () =>
      c.trySend([buildSetRoyaltyIx({ authority: admin.publicKey, royaltyBps: 1000, recipient: admin.publicKey })], [admin])
    );
  }

  // ── GC-19: admin handover + pause ──
  const newAdmin = Keypair.generate();
  await conn.confirmTransaction(await conn.requestAirdrop(newAdmin.publicKey, 5 * LAMPORTS_PER_SOL), "confirmed");
  await c.rejects("GC-19a", "non-admin propose_authority", /Unauthorized|ConstraintHasOne|2001/, () =>
    c.trySend([buildProposeAuthorityIx({ authority: intruder.publicKey, newAuthority: intruder.publicKey })], [intruder])
  );
  await c.rejects("GC-19b", "accept_authority with nothing proposed", "NoPendingAuthority", () =>
    c.trySend([buildAcceptAuthorityIx({ newAuthority: intruder.publicKey })], [intruder])
  );
  await c.rejects("GC-19c", "accept_authority by a key other than the proposed one", "NoPendingAuthority", async () => {
    await c.send([buildProposeAuthorityIx({ authority: admin.publicKey, newAuthority: newAdmin.publicKey })], [admin]);
    return c.trySend([buildAcceptAuthorityIx({ newAuthority: intruder.publicKey })], [intruder]);
  });
  await c.works("GC-19d", "two-step handover: proposed key accepts; old admin loses power; hand back", async () => {
    await c.send([buildAcceptAuthorityIx({ newAuthority: newAdmin.publicKey })], [newAdmin]);
    let cfg = await c.config();
    if (cfg.authority !== newAdmin.publicKey.toBase58() || cfg.pendingAuthority !== PublicKey.default.toBase58()) throw new Error("handover state");
    const oldTry = await c.trySend([buildSetPausedIx({ authority: admin.publicKey, paused: true })], [admin]);
    if (oldTry === null || !/Unauthorized|ConstraintHasOne|2001/.test(oldTry)) throw new Error("old admin still works");
    await c.send([buildProposeAuthorityIx({ authority: newAdmin.publicKey, newAuthority: admin.publicKey })], [newAdmin]);
    await c.send([buildAcceptAuthorityIx({ newAuthority: admin.publicKey })], [admin]);
    cfg = await c.config();
    if (cfg.authority !== admin.publicKey.toBase58()) throw new Error("hand back failed");
    return "authority moved to the proposed key, old key rejected (Unauthorized), then handed back";
  });

  // ── Wheel removed (Oct 12, 2026): its instructions no longer exist in the program ──
  const player = await c.newUser(200_000n);
  await c.rejects("WR-1", "call the removed request_spin instruction (wheel removed)", /InstructionFallbackNotFound|0x65|101/, () =>
    c.trySend([new TransactionInstruction({ programId: PID, keys: [{ pubkey: player.kp.publicKey, isSigner: true, isWritable: true }], data: Buffer.concat([Buffer.from("ba9d72d93774df72", "hex"), Buffer.alloc(18)]) })], [player.kp])
  );
  await c.rejects("WR-2", "call the removed set_wheel_params instruction", /InstructionFallbackNotFound|0x65|101/, () =>
    c.trySend([new TransactionInstruction({ programId: PID, keys: [{ pubkey: admin.publicKey, isSigner: true, isWritable: true }], data: Buffer.concat([Buffer.from("f13c4f47014bad7c", "hex"), Buffer.alloc(18)]) })], [admin])
  );

  // ── GC-22: Merkle airdrop ──
  await c.deposit(PoolId.Airdrop, 100_000n);
  const alice = await c.newUser(0n);
  const bob = await c.newUser(0n);
  const distId = 1n;
  const [dist] = deriveAirdropDistributionPda(distId, PID);
  const entries = [
    { claimant: alice.kp.publicKey.toBase58(), amount: 30_000n * UI },
    { claimant: bob.kp.publicKey.toBase58(), amount: 20_000n * UI },
  ];
  const tree = buildMerkleTree(dist, entries);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const createIx = (id: bigint, root: Uint8Array, total: bigint, expiry: bigint, who = admin.publicKey) =>
    buildCreateAirdropIx({ authority: who, gcMint: c.gcMint, id, merkleRoot: root, totalAmountRaw: total, expiryTs: expiry, tokenProgramId: TOKEN });
  await c.rejects("GC-22a", "create_airdrop reserving more than the free vault balance", "AirdropInsufficientFunds", () =>
    c.trySend([createIx(99n, tree.root, 100_001n * UI, now + 30n * 86400n)], [admin])
  );
  await c.rejects("GC-22b", "create_airdrop with a claim window shorter than 7 days", "InvalidExpiry", () =>
    c.trySend([createIx(98n, tree.root, 50_000n * UI, now + 3600n)], [admin])
  );
  await c.rejects("GC-22c", "non-admin create_airdrop", /Unauthorized|ConstraintHasOne|2001/, () =>
    c.trySend([createIx(97n, tree.root, 1n, now + 30n * 86400n, intruder.publicKey)], [intruder])
  );
  await c.send([createIx(distId, tree.root, 50_000n * UI, now + 30n * 86400n)], [admin]);
  const claimIx = (u: User, index: bigint, amount: bigint, proof: Uint8Array[]) =>
    buildClaimAirdropIx({ claimant: u.kp.publicKey, gcMint: c.gcMint, distributionId: distId, index, amountRaw: amount, proof, tokenProgramId: TOKEN });
  await c.rejects("GC-22d", "claim with a tampered amount (over-claim)", "InvalidMerkleProof", () =>
    c.trySend([claimIx(alice, 0n, 40_000n * UI, tree.proof(0))], [alice.kp])
  );
  await c.rejects("GC-22e", "claim someone else's leaf (bob uses alice's proof)", "InvalidMerkleProof", () =>
    c.trySend([claimIx(bob, 0n, 30_000n * UI, tree.proof(0))], [bob.kp])
  );
  await c.rejects("GC-22f", "claim with a bad proof", "InvalidMerkleProof", () =>
    c.trySend([claimIx(alice, 0n, 30_000n * UI, [Buffer.alloc(32, 7)])], [alice.kp])
  );
  await c.rejects("GC-22g", "withdraw airdrop funds reserved for an open distribution", "LiabilityFloor", async () => {
    const all = await c.bal(c.pool(PoolId.Airdrop).vault);
    return c.trySend([buildWithdrawTreasuryIx({ authority: admin.publicKey, destinationAta: c.adminAta, gcMint: c.gcMint, poolId: PoolId.Airdrop, amountRaw: all, tokenProgramId: TOKEN })], [admin]);
  });
  await c.works("GC-22h", "valid claim pays exactly the leaf amount", async () => {
    await c.send([claimIx(alice, 0n, 30_000n * UI, tree.proof(0))], [alice.kp]);
    const b = await c.bal(alice.ata);
    if (b !== 30_000n * UI) throw new Error(`got ${b}`);
    return "alice +30,000 GC";
  });
  await c.rejects("GC-22i", "double claim of the same leaf", /already in use|0x0/, () => c.trySend([claimIx(alice, 0n, 30_000n * UI, tree.proof(0))], [alice.kp]));
  await c.rejects("GC-22j", "reclaim before expiry", "AirdropNotExpired", () => c.trySend([buildReclaimAirdropIx({ authority: admin.publicKey, distributionId: distId })], [admin]));

  // ── long-bonus floor ──
  await c.rejects("GC-19-floor", "withdraw long-reward funds owed as 365-day bonuses", "LiabilityFloor", async () => {
    await c.deposit(PoolId.LongRewards, 300_000n);
    const s = await c.newUser(1_000_000n);
    await c.send([buildStakeLongIx({ staker: s.kp.publicKey, gcMint: c.gcMint, stakerAta: s.ata, amountRaw: 1_000_000n * UI, trancheId: 0, tokenProgramId: TOKEN })], [s.kp]);
    const all = await c.bal(c.pool(PoolId.LongRewards).vault);
    return c.trySend([buildWithdrawTreasuryIx({ authority: admin.publicKey, destinationAta: c.adminAta, gcMint: c.gcMint, poolId: PoolId.LongRewards, amountRaw: all, tokenProgramId: TOKEN })], [admin]);
  });

  // ── GC-19: pause enforcement ──
  const seller = await c.newUser(100_000n);
  const buyer = await c.newUser(100_000n);
  const listed = await c.listFor(seller, 1_000n);
  const offered = await c.mintNft(seller);
  await c.send([c.offerIx(buyer, offered.mint, 500n)], [buyer.kp]);
  const staker = await c.newUser(10_000n);
  await c.send([buildStakeDailyIx({ staker: staker.kp.publicKey, gcMint: c.gcMint, stakerAta: staker.ata, amountRaw: 5_000n * UI, tokenProgramId: TOKEN })], [staker.kp]);
  await c.send([buildSetPausedIx({ authority: admin.publicKey, paused: true })], [admin]);
  const pausedOps: [string, () => Promise<string | null>][] = [
    ["mint_nft", async () => { const n = Keypair.generate(); return c.trySend([c.mintIx(buyer, n.publicKey)], [buyer.kp, n]); }],
    ["list_nft", () => c.trySend([buildListNftIx({ seller: seller.kp.publicKey, nftMint: offered.mint, sellerNftAta: offered.ata, priceRaw: 1n * UI })], [seller.kp])],
    ["buy_nft", () => c.trySend([c.buyIx(buyer, seller, listed.mint, 1_000n)], [buyer.kp])],
    ["make_offer", () => c.trySend([c.offerIx(buyer, listed.mint, 10n)], [buyer.kp])],
    ["accept_offer", () => c.trySend([c.acceptIx(seller, buyer, offered, 500n)], [seller.kp])],
    ["stake_daily", () => c.trySend([buildStakeDailyIx({ staker: buyer.kp.publicKey, gcMint: c.gcMint, stakerAta: buyer.ata, amountRaw: 1_000n * UI, tokenProgramId: TOKEN })], [buyer.kp])],
    ["stake_long", () => c.trySend([buildStakeLongIx({ staker: buyer.kp.publicKey, gcMint: c.gcMint, stakerAta: buyer.ata, amountRaw: 1_000n * UI, trancheId: 0, tokenProgramId: TOKEN })], [buyer.kp])],
    ["deposit_treasury", () => c.trySend([buildDepositTreasuryIx({ depositor: admin.publicKey, depositorAta: c.adminAta, gcMint: c.gcMint, poolId: PoolId.DailyRewards, amountRaw: 1n, tokenProgramId: TOKEN })], [admin])],
    ["claim_airdrop", () => c.trySend([claimIx(bob, 1n, 20_000n * UI, tree.proof(1))], [bob.kp])],
    ["create_airdrop", () => c.trySend([createIx(5n, tree.root, 1n, now + 30n * 86400n)], [admin])],
    ["settle_mint", () => c.trySend([buildSettleMintIx({ nftMint: offered.mint })], [buyer.kp])],
    ["request_mint_vrf", () => c.trySend([buildRequestMintVrfIx({ payer: buyer.kp.publicKey, nftMint: offered.mint, attempt: 2, previousAttempt: 1, vrfTreasury: c.orao.treasury })], [buyer.kp])],
  ];
  for (const [name, op] of pausedOps) await c.rejects(`GC-19-pause-${name}`, `${name} while paused`, "Paused", op);
  await c.works("GC-19-exits", "while paused: cancel_listing, cancel_offer, admin withdraw (above floors) still work; unstake/claim_long hit only their own locks", async () => {
    mustOk(await c.trySend([buildCancelListingIx({ seller: seller.kp.publicKey, nftMint: listed.mint, sellerNftAta: listed.ata })], [seller.kp]), "cancel_listing");
    mustOk(await c.trySend([buildCancelOfferIx({ bidder: buyer.kp.publicKey, nftMint: offered.mint, gcMint: c.gcMint, bidderGcAta: buyer.ata, tokenProgramId: TOKEN })], [buyer.kp]), "cancel_offer");
    mustOk(await c.trySend([buildWithdrawTreasuryIx({ authority: admin.publicKey, destinationAta: c.adminAta, gcMint: c.gcMint, poolId: PoolId.MintProceeds, amountRaw: 1n * UI, tokenProgramId: TOKEN })], [admin]), "withdraw");
    const un = await c.trySend([buildUnstakeDailyIx({ staker: staker.kp.publicKey, gcMint: c.gcMint, stakerAta: staker.ata, tokenProgramId: TOKEN })], [staker.kp]);
    if (un === null || !un.includes("MinLockNotMet") || un.includes("Paused")) throw new Error(`unstake_daily: ${un?.slice(0, 300)}`);
    return "exits not pause-gated (unstake_daily → MinLockNotMet, never Paused)";
  });
  await c.send([buildSetPausedIx({ authority: admin.publicKey, paused: false })], [admin]);

  // ── Staking switch: locking blocks NEW stakes only; existing positions keep unstake/claim ──
  {
    const fresh = await c.newUser(5_000n);
    const longStaker = await c.newUser(2_000n);
    await c.send([buildStakeLongIx({ staker: longStaker.kp.publicKey, gcMint: c.gcMint, stakerAta: longStaker.ata, amountRaw: 1_000n * UI, trancheId: 0, tokenProgramId: TOKEN })], [longStaker.kp]);
    await c.send([buildSetStakingEnabledIx({ authority: admin.publicKey, enabled: false })], [admin]);
    await c.rejects("SL-f", "stake_daily (new staker) after admin re-locked staking", "StakingLocked", () =>
      c.trySend([buildStakeDailyIx({ staker: fresh.kp.publicKey, gcMint: c.gcMint, stakerAta: fresh.ata, amountRaw: 1_000n * UI, tokenProgramId: TOKEN })], [fresh.kp])
    );
    await c.rejects("SL-g", "add_daily (top-up of an existing stake) while locked", "StakingLocked", () =>
      c.trySend([buildAddDailyIx({ staker: staker.kp.publicKey, gcMint: c.gcMint, stakerAta: staker.ata, amountRaw: 1_000n * UI, tokenProgramId: TOKEN })], [staker.kp])
    );
    await c.rejects("SL-h", "stake_long (next tranche) while locked", "StakingLocked", () =>
      c.trySend([buildStakeLongIx({ staker: longStaker.kp.publicKey, gcMint: c.gcMint, stakerAta: longStaker.ata, amountRaw: 500n * UI, trancheId: 1, tokenProgramId: TOKEN })], [longStaker.kp])
    );
    await c.works("SL-i", "while locked: unstake_daily / claim_daily / claim_long are NOT gated (only their own time locks)", async () => {
      const un = await c.trySend([buildUnstakeDailyIx({ staker: staker.kp.publicKey, gcMint: c.gcMint, stakerAta: staker.ata, tokenProgramId: TOKEN })], [staker.kp]);
      if (un === null || !un.includes("MinLockNotMet") || un.includes("StakingLocked")) throw new Error(`unstake_daily: ${un?.slice(0, 300)}`);
      const cd = await c.trySend([buildClaimDailyIx({ staker: staker.kp.publicKey, gcMint: c.gcMint, stakerAta: staker.ata, tokenProgramId: TOKEN })], [staker.kp]);
      if (cd === null || !cd.includes("NothingToClaim") || cd.includes("StakingLocked")) throw new Error(`claim_daily: ${cd?.slice(0, 300)}`);
      const cl = await c.trySend([buildClaimLongIx({ staker: longStaker.kp.publicKey, gcMint: c.gcMint, stakerAta: longStaker.ata, trancheId: 0, tokenProgramId: TOKEN })], [longStaker.kp]);
      if (cl === null || !cl.includes("StillLocked") || cl.includes("StakingLocked")) throw new Error(`claim_long: ${cl?.slice(0, 300)}`);
      return "unstake_daily → MinLockNotMet, claim_daily → NothingToClaim, claim_long → StillLocked (never StakingLocked)";
    });
    await c.works("SL-j", "admin re-opens staking → add_daily + stake_long work again", async () => {
      await c.send([buildSetStakingEnabledIx({ authority: admin.publicKey, enabled: true })], [admin]);
      await c.send([buildAddDailyIx({ staker: staker.kp.publicKey, gcMint: c.gcMint, stakerAta: staker.ata, amountRaw: 1_000n * UI, tokenProgramId: TOKEN })], [staker.kp]);
      await c.send([buildStakeLongIx({ staker: longStaker.kp.publicKey, gcMint: c.gcMint, stakerAta: longStaker.ata, amountRaw: 500n * UI, trancheId: 1, tokenProgramId: TOKEN })], [longStaker.kp]);
      return "open again";
    });
  }

  // ── GC-17: instant per-mint reveal (FIFO queue, VRF per mint, swap-and-pop pool) ──
  const q0 = await fetchRevealQueue(conn, PID);
  const head = q0.entries[0];
  const second = q0.entries[1];
  if (!head?.nftMint || !second?.nftMint || q0.head !== 0) throw new Error(`queue ${JSON.stringify(q0.entries.slice(0, 2))}`);
  const headMint = new PublicKey(head.nftMint);
  const secondMint = new PublicKey(second.nftMint);
  await c.rejects("GC-17a", "settle_mint before ORAO fulfilment", "VrfNotFulfilled", () => c.trySend([buildSettleMintIx({ nftMint: headMint })], [buyer.kp]));
  await fulfillOrao(conn, c.orao, mintVrfSeed(secondMint, 1, PID));
  await c.rejects("GC-17b", "settle a fulfilled NFT out of order (skip the head to steer the pool)", "NotQueueHead", () => c.trySend([buildSettleMintIx({ nftMint: secondMint })], [buyer.kp]));
  await c.rejects("GC-17c", "settle the head with another NFT's fulfilled randomness", /InvalidVrfAccount|ConstraintSeeds/, async () => {
    const o = buildSettleMintIx({ nftMint: headMint });
    swapKey(o, 8, deriveOraoRandomnessPda(mintVrfSeed(secondMint, 1, PID)));
    return c.trySend([o], [buyer.kp]);
  });
  await c.rejects("GC-17d", "re-request a pending (unexpired) mint VRF (re-roll)", "VrfNotExpired", () =>
    c.trySend([buildRequestMintVrfIx({ payer: buyer.kp.publicKey, nftMint: headMint, attempt: 2, previousAttempt: 1, vrfTreasury: c.orao.treasury })], [buyer.kp])
  );
  await c.rejects("GC-17e", "re-request a FULFILLED mint VRF (re-roll a known result)", "VrfAlreadyFulfilled", () =>
    c.trySend([buildRequestMintVrfIx({ payer: buyer.kp.publicKey, nftMint: secondMint, attempt: 2, previousAttempt: 1, vrfTreasury: c.orao.treasury })], [buyer.kp])
  );
  await c.rejects("GC-17f", "re-request without proving the old request (no previous_request)", "RevealAlreadyRequested", () =>
    c.trySend([buildRequestMintVrfIx({ payer: buyer.kp.publicKey, nftMint: headMint, attempt: 2, vrfTreasury: c.orao.treasury })], [buyer.kp])
  );
  await c.rejects("GC-17g", "init_mint_pool again (reset the pool)", "MintPoolReady", () =>
    c.trySend([buildInitMintPoolIx({ payer: buyer.kp.publicKey })], [buyer.kp])
  );
  await c.rejects("GC-17h", "settle_mint with a forged mint_pool account", /ConstraintSeeds|AccountOwnedByWrongProgram|AccountNotInitialized|AccountDiscriminator/, () => {
    const ix = buildSettleMintIx({ nftMint: headMint });
    swapKey(ix, 2, intruder.publicKey);
    return c.trySend([ix], [buyer.kp]);
  });
  await c.rejects("GC-17i", "settle_mint pointing at a different NFT's metadata (rewrite someone else's cat)", "InvalidMetadata", () => {
    const ix = buildSettleMintIx({ nftMint: headMint });
    swapKey(ix, 5, deriveMetadataPda(secondMint)[0]);
    return c.trySend([ix], [buyer.kp]);
  });
  await c.works("GC-17j", "anyone settles the whole queue in mint order: unique ids, catalog rarity, matches the off-chain mirror, metadata → GreenCat #id", async () => {
    const settled = await settleQueue(conn, c.orao, intruder);
    const mirror = new Uint16Array(10_000);
    const seen = new Set<number>();
    for (let k = 0; k < settled.length; k++) {
      const x = settled[k];
      if (x.mintIndex !== k) throw new Error(`order ${x.mintIndex} != ${k}`);
      const want = poolTake(mirror, poolIndexFromRandomness(x.randomness, new PublicKey(x.mint), 10_000 - k), 10_000 - k);
      if (x.tokenId !== want || seen.has(want)) throw new Error(`#${k}: ${x.tokenId} vs mirror ${want}`);
      seen.add(want);
      if (x.rarity !== rarityToU8(getTokenRarity(want))) throw new Error("rarity");
      const md = parseMetadata((await conn.getAccountInfo(deriveMetadataPda(new PublicKey(x.mint))[0]))!.data);
      if (md.name !== `GreenCat #${want}` || !md.uri.endsWith(`/${want}.json`) || !md.collection?.verified || md.sellerFeeBasisPoints !== 500) throw new Error(`md ${md.name} ${md.uri}`);
    }
    const col = decodeCollectionAccount((await conn.getAccountInfo(deriveCollectionPda(PID)[0]))!.data)!;
    if (Number(col.revealedCount) !== settled.length || col.revealedCount !== col.mintedCount) throw new Error("counts");
    return `${settled.length} NFTs revealed in order, ids unique (${[...seen].slice(0, 5).join(", ")}…)`;
  });
  await c.rejects("GC-17k", "settle_mint twice", "AlreadyRevealed", () => c.trySend([buildSettleMintIx({ nftMint: headMint })], [buyer.kp]));
  await c.works("GC-17l", "mint → fulfil → settle in consecutive txs reveals within the same flow (instant reveal)", async () => {
    const nft = await c.mintNft(buyer);
    const [x] = await settleQueue(conn, c.orao, buyer.kp);
    const rec = decodeNftRecordAccount((await conn.getAccountInfo(deriveNftRecordPda(nft.mint, PID)[0]))!.data)!;
    if (!x || x.mint !== nft.mint.toBase58() || !rec.revealed) throw new Error("not revealed");
    return `GreenCat #${rec.tokenId}`;
  });
  await c.rejects("GC-17m", "non-admin close_mint", /Unauthorized|ConstraintHasOne|2001/, () => c.trySend([buildCloseMintIx({ authority: intruder.publicKey })], [intruder]));
  await c.send([buildCloseMintIx({ authority: admin.publicKey })], [admin]);
  await c.rejects("GC-17n", "mint after close_mint", "MintClosed", async () => { const n = Keypair.generate(); return c.trySend([c.mintIx(buyer, n.publicKey)], [buyer.kp, n]); });
}

// ═════════════════════════════════════════════════════════════════════════════
// Phase short (time-window paths)
// ═════════════════════════════════════════════════════════════════════════════
async function phaseShort(c: Ctx) {
  await setupBase(c);
  const conn = c.conn;
  const admin = c.admin;
  await initAll(c);
  await c.send([buildCreateCollectionNftIx({ authority: admin.publicKey })], [admin]);
  await c.send([buildSetVrfExpiryIx({ authority: admin.publicKey, expirySecs: 2 })], [admin]);
  // per-mint reveal: re-request after an expired, unfulfilled VRF
  const minter = await c.newUser(30_000n);
  const nft = await c.mintNft(minter);
  const s1 = mintVrfSeed(nft.mint, 1, PID);
  const s2 = mintVrfSeed(nft.mint, 2, PID);
  const rereq = (prev: number | null) => buildRequestMintVrfIx({ payer: minter.kp.publicKey, nftMint: nft.mint, attempt: 2, previousAttempt: prev, vrfTreasury: c.orao.treasury });
  await sleep(3500);
  await c.rejects("GC-17-rereq-noprev", "re-request after expiry without proving the old request is unfulfilled", "RevealAlreadyRequested", () => c.trySend([rereq(null)], [minter.kp]));
  await c.works("GC-17-rereq", "expired + unfulfilled mint VRF can be re-requested by anyone (attempt 2)", async () => {
    await c.send([rereq(1)], [minter.kp]);
    const q = await fetchRevealQueue(conn, PID);
    if (q.entries[0]?.attempt !== 2) throw new Error(`attempt ${q.entries[0]?.attempt}`);
    return "attempt 2 recorded in the queue slot";
  });
  await c.rejects("GC-17-stale", "late fulfilment of attempt 1 cannot settle (only the current seed counts)", /InvalidVrfAccount|ConstraintSeeds/, async () => {
    await fulfillOrao(conn, c.orao, s1);
    return c.trySend([buildSettleMintIx({ nftMint: nft.mint, attempt: 1 })], [minter.kp]);
  });
  await c.works("GC-17-settle2", "attempt 2 fulfils and settles", async () => {
    await fulfillOrao(conn, c.orao, s2);
    await c.send([buildSettleMintIx({ nftMint: nft.mint, attempt: 2 })], [minter.kp]);
    const rec = decodeNftRecordAccount((await conn.getAccountInfo(deriveNftRecordPda(nft.mint, PID)[0]))!.data)!;
    if (!rec.revealed) throw new Error("not revealed");
    return `GreenCat #${rec.tokenId}`;
  });

  // Merkle expiry / reclaim
  await c.deposit(PoolId.Airdrop, 10_000n);
  const alice = await c.newUser(0n);
  const [dist] = deriveAirdropDistributionPda(1n, PID);
  const tree = buildMerkleTree(dist, [{ claimant: alice.kp.publicKey.toBase58(), amount: 1_000n * UI }]);
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  await c.send([buildCreateAirdropIx({ authority: admin.publicKey, gcMint: c.gcMint, id: 1n, merkleRoot: tree.root, totalAmountRaw: 1_000n * UI, expiryTs: nowSec + 4n, tokenProgramId: TOKEN })], [admin]);
  await sleep(5500);
  await c.rejects("GC-22-claim-expired", "claim after expiry", "AirdropExpired", () =>
    c.trySend([buildClaimAirdropIx({ claimant: alice.kp.publicKey, gcMint: c.gcMint, distributionId: 1n, index: 0n, amountRaw: 1_000n * UI, proof: tree.proof(0), tokenProgramId: TOKEN })], [alice.kp])
  );
  await c.rejects("GC-22-reclaim-paused", "reclaim while paused (pause-to-block-claims-then-reclaim)", /Paused|ReclaimGracePeriod/, async () => {
    await c.send([buildSetPausedIx({ authority: admin.publicKey, paused: true })], [admin]);
    const r = await c.trySend([buildReclaimAirdropIx({ authority: admin.publicKey, distributionId: 1n })], [admin]);
    await c.send([buildSetPausedIx({ authority: admin.publicKey, paused: false })], [admin]);
    return r;
  });
  await c.works("GC-22-reclaim", "after expiry (+ grace since last pause change) admin reclaims; reservation released; second reclaim fails", async () => {
    await sleep(2000);
    const before = (await c.config()).airdropReserved;
    await c.send([buildReclaimAirdropIx({ authority: admin.publicKey, distributionId: 1n })], [admin]);
    const after = (await c.config()).airdropReserved;
    const again = await c.trySend([buildReclaimAirdropIx({ authority: admin.publicKey, distributionId: 1n })], [admin]);
    if (!(before === 1_000n * UI && after === 0n)) throw new Error(`reserved ${before}→${after}`);
    if (again === null || !again.includes("AirdropAlreadyReclaimed")) throw new Error("double reclaim");
    return "airdrop_reserved 1,000 → 0 GC; withdrawable again; double reclaim → AirdropAlreadyReclaimed";
  });
}

async function main() {
  console.log(`[security] gcTokenProgram=${TOKEN_NAME} phase=${PHASE}`);
  const basePort = Number(process.env.E2E_RPC_PORT || 18999);
  if (PHASE === "all" || PHASE === "main") {
    const ln = await startLocalnet({ so: process.env.SECURITY_SO || SO_DEFAULT, port: basePort, tag: "sec-main" });
    try {
      await phaseMain(new Ctx(ln, "main"));
    } finally {
      ln.stop();
    }
  }
  if (PHASE === "all" || PHASE === "short") {
    const ln = await startLocalnet({ so: SO_SHORT, port: basePort + 100, tag: "sec-short" });
    try {
      await phaseShort(new Ctx(ln, "short"));
    } finally {
      ln.stop();
    }
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n[security] ${TOKEN_NAME}: ${results.length - failed.length}/${results.length} passed`);
  fs.mkdirSync(path.join(ROOT, "target"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, `target/security-negative-${TOKEN_NAME}.json`), JSON.stringify(results, null, 2));
  if (failed.length) {
    console.log("FAILED:", failed.map((f) => `${f.phase}:${f.id}`).join(", "));
    process.exit(1);
  }
  console.log("SECURITY NEGATIVE PASS");
}

void SystemProgram;
void deriveDailyStakePda;
void deriveLongTranchePda;
void buildClaimLongIx;
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
