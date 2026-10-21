/**
 * Localnet smoke of the operational scripts in /scripts (run as real CLI processes against a local
 * validator): init-treasuries → init-collection → mint ×2 → admin status/pause/unpause →
 * reveal status/settle (per-mint reveal) → close-mint → list → buy (expected price, wrong + right) →
 * airdrop snapshot → launch-airdrop path (hold-check balances → top-N equal split with the exclude list →
 * create_airdrop → on-chain claims with the published proofs). No network access, no devnet.
 *   npm run test:scripts --workspace=@greencat/api
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, createMint, getAccount, getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount, mintTo, transferChecked } from "@solana/spl-token";
import {
  PoolId,
  buildClaimAirdropIx,
  decodeCollectionAccount,
  deriveCollectionPda,
  deriveTreasuryPda,
  deriveTreasuryVaultAta,
  mintVrfSeed,
} from "@greencat/sdk";
import { PID, ROOT, airdrop, assert, expectFail, fulfillOrao, initOrao, sendIxs, startLocalnet } from "./localnet";

const UI = 1_000_000n;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gc-scripts-"));
const keyFile = (k: Keypair, n: string) => {
  const p = path.join(tmp, `${n}.json`);
  fs.writeFileSync(p, JSON.stringify(Array.from(k.secretKey)));
  return p;
};

async function main() {
  const ln = await startLocalnet({ port: 18999, tag: "scripts" });
  try {
    const { conn, upgradeAuthority: admin } = ln;
    const orao = await initOrao(conn, admin);
    const buyer = Keypair.generate();
    await airdrop(conn, buyer.publicKey, 10);
    const gcMint = await createMint(conn, admin, admin.publicKey, null, 6, undefined, undefined, TOKEN_2022_PROGRAM_ID);
    for (const o of [admin, buyer]) {
      const ata = await getOrCreateAssociatedTokenAccount(conn, admin, gcMint, o.publicKey, false, undefined, undefined, TOKEN_2022_PROGRAM_ID);
      await mintTo(conn, admin, gcMint, ata.address, admin, Number(100_000n * UI), [], undefined, TOKEN_2022_PROGRAM_ID);
    }
    const adminKey = keyFile(admin, "admin");
    const buyerKey = keyFile(buyer, "buyer");
    const run = (script: string, args: string[] = [], env: Record<string, string> = {}, expectFail: false | string | RegExp = false) => {
      const full = { ...process.env, RPC_URL: ln.rpcUrl, KEYPAIR_PATH: adminKey, ...env };
      try {
        const out = execFileSync("npx", ["tsx", path.join(ROOT, "scripts", script), ...args], { cwd: ROOT, env: full, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        if (expectFail) throw new Error(`[${script} ${args.join(" ")}] expected failure but succeeded:\n${out}`);
        console.log(`  ✓ ${script} ${args.join(" ")}`);
        return out;
      } catch (e) {
        const err = e as { stderr?: string; stdout?: string; message: string };
        if (!expectFail || err.message.includes("expected failure")) throw new Error(`${script} failed:\n${err.stdout ?? ""}\n${err.stderr ?? err.message}`);
        const text = `${err.stdout ?? ""}\n${err.stderr ?? ""}`;
        const ok = typeof expectFail === "string" ? text.includes(expectFail) : expectFail.test(text);
        if (!ok) throw new Error(`${script} ${args.join(" ")} failed, but not with ${String(expectFail)}:\n${text.slice(0, 3000)}`);
        console.log(`  ✓ ${script} ${args.join(" ")} (rejected: ${String(expectFail)})`);
        return text;
      }
    };

    // a non-upgrade-authority key must be refused by the script's pre-check / the program (GC-20)
    run("initialize-treasuries.ts", [], { GC_MINT: gcMint.toBase58(), KEYPAIR_PATH: buyerKey }, "is not the upgrade authority");
    run("initialize-treasuries.ts", [], { GC_MINT: gcMint.toBase58() });
    run("initialize-collection.ts", [], { ROYALTY_BPS: "500" });
    const status = run("admin.ts", ["status"]);
    assert(!status.includes("houseEdgeBps"), "status no longer shows wheel params (wheel removed)");
    run("admin.ts", ["wheel", "400", "10", "50000"], {}, /unknown|usage|Usage/); // removed command
    const printed = run("admin.ts", ["pause"], { PRINT_ONLY: "1", AUTHORITY: admin.publicKey.toBase58() });
    assert(/data/i.test(printed), "PRINT_ONLY prints the instruction");

    const m1 = /nft mint (\w+)/.exec(run("mint-nft.ts", [], { KEYPAIR_PATH: buyerKey, NO_SETTLE: "1" }))![1];
    run("admin.ts", ["pause"]);
    run("mint-nft.ts", [], { NO_SETTLE: "1" }, "Error Code: Paused"); // paused
    run("admin.ts", ["unpause"]);
    const m2 = /nft mint (\w+)/.exec(run("mint-nft.ts", [], { NO_SETTLE: "1" }))![1];
    run("admin.ts", ["royalty", "300", admin.publicKey.toBase58()], {}, "Error Code: RoyaltyLocked"); // after first mint

    assert(run("reveal.ts", ["status"]).includes("pending: 2"), "2 pending reveals");
    assert(run("reveal.ts", ["settle"]).includes("settled 0"), "nothing settles before ORAO fulfils");
    run("reveal.ts", ["init-pool"], {}, "Error Code: MintPoolReady");
    for (const m of [m1, m2]) await fulfillOrao(conn, orao, mintVrfSeed(new PublicKey(m), 1, PID));
    const settledOut = run("reveal.ts", ["settle"], { KEYPAIR_PATH: buyerKey });
    assert(settledOut.includes("settled 2") && /GreenCat #\d+/.test(settledOut), `both NFTs revealed:\n${settledOut}`);
    const [colPda] = deriveCollectionPda(PID);
    const col = decodeCollectionAccount(Buffer.from((await conn.getAccountInfo(colPda))!.data))!;
    assert(col.revealedCount === 2n, "revealedCount 2");
    run("admin.ts", ["close-mint"]);
    run("mint-nft.ts", [], { NO_SETTLE: "1" }, "Error Code: MintClosed");

    run("list-nft.ts", [m1, "1234.5"], { KEYPAIR_PATH: buyerKey });
    run("buy-nft.ts", [m1, "1000"], {}, "Error Code: PriceMismatch"); // expected price mismatch (GC-21)
    run("buy-nft.ts", [m1, "1234.5"]);

    const out = path.join(tmp, "airdrop");
    const snap = run("airdrop.ts", ["snapshot", "--id", "1", "--total-ui", "1000", "--min-holding-ui", "1", "--out", out], {
      GC_MINT: gcMint.toBase58(),
      TOKEN_PROGRAM: "token2022",
    });
    const proofs = fs.readdirSync(out).find((f) => f.startsWith("airdrop-1") && f.endsWith(".json"));
    assert(proofs, `proofs file written:\n${snap}\n${fs.readdirSync(out).join(",")}`);
    console.log(`  (m2=${m2.slice(0, 8)}…, proofs ${proofs})`);

    // ── Launch airdrop end to end (BUGSWEEP-2026-10-07): hold-check output → top-N equal split → exclusions →
    //    create_airdrop → every published proof claims on-chain; excluded / unranked wallets can't. ──
    const T22 = TOKEN_2022_PROGRAM_ID;
    const holders = Array.from({ length: 4 }, () => Keypair.generate()); // h0 > h1 > h2 > h3 by snapshot balance
    const team = Keypair.generate(); // biggest balance, but on the exclude list
    const small = Keypair.generate(); // below the 100k minimum
    const offCurve = PublicKey.findProgramAddressSync([Buffer.from("bugsweep-pool")], PID)[0]; // a PDA (LP / vault)
    const raw = (ui: bigint) => (ui * UI).toString();
    const balancesFile = path.join(tmp, "hold-qualified.json");
    fs.writeFileSync(balancesFile, JSON.stringify({
      [team.publicKey.toBase58()]: raw(900_000n),
      [offCurve.toBase58()]: raw(800_000n),
      [holders[0].publicKey.toBase58()]: raw(500_000n),
      [holders[1].publicKey.toBase58()]: raw(400_000n),
      [holders[2].publicKey.toBase58()]: raw(300_000n),
      [holders[3].publicKey.toBase58()]: raw(200_000n),
      [small.publicKey.toBase58()]: raw(50_000n),
    }));
    const excludeFile = path.join(tmp, "exclude.json");
    fs.writeFileSync(excludeFile, JSON.stringify({ _about: "test", team: [{ address: team.publicKey.toBase58(), note: "team" }] }));
    const out2 = path.join(tmp, "airdrop2");
    const launchArgs = ["snapshot", "--id", "2", "--balances", balancesFile, "--top", "3", "--split", "equal", "--total-ui", "1000", "--min-holding-ui", "100000", "--out", out2];
    const envT22 = { GC_MINT: gcMint.toBase58(), TOKEN_PROGRAM: "token2022" };
    run("airdrop.ts", [...launchArgs, "--exclude-file", excludeFile], envT22);
    const f2 = JSON.parse(fs.readFileSync(path.join(out2, "airdrop-2-proofs.json"), "utf8"));
    const got = new Set<string>(f2.claims.map((c: { claimant: string }) => c.claimant));
    const want = holders.slice(0, 3).map((h) => h.publicKey.toBase58());
    assert(f2.claims.length === 3 && want.every((w) => got.has(w)), `top 3 by snapshot balance = h0,h1,h2 (got ${[...got].join(",")})`);
    assert(!got.has(team.publicKey.toBase58()) && !got.has(offCurve.toBase58()) && !got.has(small.publicKey.toBase58()), "excluded / PDA / below-min wallets left out");
    assert(f2.claims.every((c: { amountRaw: string }) => c.amountRaw === "333333333") && f2.totalAmountRaw === "999999999", "equal split floor(1000 GC / 3), 1 raw dust stays in the pool");
    console.log("  ✓ launch airdrop: top-3 equal split (333.333333 GC each), team wallet (exclude file), PDA and below-minimum wallets excluded");
    // Without --exclude-file the default list (scripts/airdrop-exclude.json) still applies; a team wallet from it is never selected.
    const defaultList = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/airdrop-exclude.json"), "utf8"));
    const teamWallet: string = defaultList.team[0].address;
    fs.writeFileSync(balancesFile, JSON.stringify({ [teamWallet]: raw(999_000n), [holders[0].publicKey.toBase58()]: raw(500_000n) }));
    const out3 = path.join(tmp, "airdrop3");
    run("airdrop.ts", ["snapshot", "--id", "3", "--balances", balancesFile, "--top", "3", "--split", "equal", "--total-ui", "1000", "--min-holding-ui", "100000", "--out", out3], envT22);
    const f3 = JSON.parse(fs.readFileSync(path.join(out3, "airdrop-3-proofs.json"), "utf8"));
    assert(f3.claims.length === 1 && f3.claims[0].claimant === holders[0].publicKey.toBase58() && f3.rules.excludeListSize > 0, "default exclude list applied");
    console.log("  ✓ default exclude list applied without --exclude-file (team wallet from scripts/airdrop-exclude.json not selected)");

    // Fund the airdrop pool, post the root with the CLI, then claim every published proof on-chain.
    const [airdropPda] = deriveTreasuryPda(PoolId.Airdrop, PID);
    const poolVault = deriveTreasuryVaultAta(gcMint, airdropPda, T22);
    const adminAta = getAssociatedTokenAddressSync(gcMint, admin.publicKey, false, T22);
    await transferChecked(conn, admin, adminAta, gcMint, poolVault, admin, 1_000n * UI, 6, [], { commitment: "confirmed" }, T22);
    run("airdrop.ts", ["create", path.join(out2, "airdrop-2-proofs.json")], envT22);
    const proofOf = (c: { proof: string[] }) => c.proof.map((h) => Buffer.from(h, "hex"));
    const claimIx = (claimant: PublicKey, c: { index: number; amountRaw: string; proof: string[] }) =>
      buildClaimAirdropIx({ claimant, gcMint, distributionId: 2n, index: BigInt(c.index), amountRaw: BigInt(c.amountRaw), proof: proofOf(c), tokenProgramId: T22, programId: PID });
    for (const k of [...holders, team]) await airdrop(conn, k.publicKey, 1);
    const byWallet = new Map<string, { index: number; amountRaw: string; proof: string[] }>(f2.claims.map((c: { claimant: string }) => [c.claimant, c]));
    // excluded / unranked wallets replaying someone else's proof are rejected
    const c0 = byWallet.get(holders[0].publicKey.toBase58())!;
    await expectFail(sendIxs(conn, [team], [claimIx(team.publicKey, c0)]), "InvalidMerkleProof", "team wallet replays h0's proof");
    await expectFail(sendIxs(conn, [holders[3]], [claimIx(holders[3].publicKey, c0)]), "InvalidMerkleProof", "rank-4 wallet replays h0's proof");
    await expectFail(sendIxs(conn, [holders[0]], [claimIx(holders[0].publicKey, { ...c0, amountRaw: "333333334" })]), "InvalidMerkleProof", "inflated amount");
    for (const h of holders.slice(0, 3)) {
      const c = byWallet.get(h.publicKey.toBase58())!;
      await sendIxs(conn, [h], [claimIx(h.publicKey, c)]);
      const ata = getAssociatedTokenAddressSync(gcMint, h.publicKey, false, T22);
      assert((await getAccount(conn, ata, "confirmed", T22)).amount === 333_333_333n, "claimed exactly the share");
    }
    await expectFail(sendIxs(conn, [holders[0]], [claimIx(holders[0].publicKey, c0)]), /already in use|0x0/, "double claim");
    const left = (await getAccount(conn, poolVault, "confirmed", T22)).amount;
    assert(left === 1n, `airdrop pool keeps the 1 raw dust (left ${left})`);
    console.log("  ✓ create_airdrop from the proofs file; all 3 proofs claim on-chain (333.333333 GC each); team / rank-4 / inflated / double claims rejected; 1 raw dust left in the pool");
    console.log("SCRIPTS LOCALNET: PASS");
  } finally {
    ln.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  }
);
