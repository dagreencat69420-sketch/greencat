/**
 * Localnet check for the /admin "Set VRF expiry" control (not run in CI; needs solana-test-validator).
 *
 * Uses the production build (target/deploy/greencat.so: VRF expiry 3,600 … 604,800 s) and the exact builder
 * the web app sends (`buildSetVrfExpiryIxChecked` → `set_vrf_expiry`), with a throw-away test admin
 * (the validator's upgrade authority → config.authority). Proves:
 *   default is 24 h · a non-admin signer is refused (also in the preflight simulation the web app runs) ·
 *   3,599 s and 604,801 s are refused on-chain (and by the checked builder before any wallet prompt) ·
 *   the admin can set 3,600 s (the /admin tile then reads "60 min") · it also works while paused ·
 *   it can be set back to 86,400 s · min/max themselves are accepted.
 *
 *   npx tsx apps/api/test/vrf-expiry-localnet.ts      (from the repo root)
 */
import { Keypair, Transaction, VersionedTransaction } from "@solana/web3.js";
import { createMint, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  buildSetPausedIx,
  buildSetVrfExpiryIx,
  buildSetVrfExpiryIxChecked,
  decodeConfigAccount,
  deriveConfigPda,
  formatVrfExpiry,
  parseVrfExpiryInput,
  VRF_EXPIRY_MAX_SECS,
  VRF_EXPIRY_MIN_SECS,
} from "@greencat/sdk";
import { PID, SO_DEFAULT, airdrop, assert, errText, initProgram, sendIxs, startLocalnet } from "./localnet";

async function main() {
  const ln = await startLocalnet({ so: process.env.VRF_SO || SO_DEFAULT, port: Number(process.env.E2E_RPC_PORT || 19399), tag: "vrfexp" });
  const { conn } = ln;
  const admin = ln.upgradeAuthority;
  let pass = 0;
  const ok = (m: string) => {
    pass++;
    console.log(`  ✓ ${m}`);
  };
  const rejects = async (m: string, want: RegExp, f: () => Promise<unknown>) => {
    try {
      await f();
    } catch (e) {
      const t = errText(e);
      assert(want.test(t), `${m}: expected ${want}, got:\n${t.slice(0, 800)}`);
      return ok(`${m} → refused (${want.source})`);
    }
    throw new Error(`${m}: expected failure ${want}, but it succeeded`);
  };
  const expiry = async () => Number(decodeConfigAccount(Buffer.from((await conn.getAccountInfo(deriveConfigPda(PID)[0], "confirmed"))!.data))!.vrfExpirySecs);
  const set = (secs: number, signer = admin) => sendIxs(conn, [signer], [buildSetVrfExpiryIxChecked({ authority: signer.publicKey, expirySecs: secs })]);
  try {
    const mint = await createMint(conn, admin, admin.publicKey, null, 6, Keypair.generate(), undefined, TOKEN_PROGRAM_ID);
    await initProgram(ln, mint, TOKEN_PROGRAM_ID, { collection: false });

    assert((await expiry()) === 86_400, "default expiry");
    ok("fresh Config: VRF expiry 86,400 s (24 h)");

    // non-admin: on-chain and in the same preflight simulation the web app runs before the wallet prompt
    const intruder = Keypair.generate();
    await airdrop(conn, intruder.publicKey, 2);
    await rejects("non-admin set_vrf_expiry(3600)", /Unauthorized|0x1770|6000/, () => set(3_600, intruder));
    const tx = new Transaction().add(buildSetVrfExpiryIxChecked({ authority: intruder.publicKey, expirySecs: 3_600 }));
    tx.feePayer = intruder.publicKey;
    tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
    const sim = await conn.simulateTransaction(VersionedTransaction.deserialize(tx.serialize({ requireAllSignatures: false, verifySignatures: false })), { sigVerify: false, replaceRecentBlockhash: true });
    assert(sim.value.err && (sim.value.logs ?? []).join("\n").match(/Unauthorized/), `preflight sim should fail with Unauthorized: ${JSON.stringify(sim.value)}`);
    ok("non-admin preflight simulation (unsigned, what /admin runs first) fails with Unauthorized");
    assert((await expiry()) === 86_400, "unchanged after intruder");

    // out of range: the program refuses; the UI parser and checked builder refuse before any prompt
    await rejects("admin set_vrf_expiry(3599)", /InvalidExpiry|0x17ac|6060/, () => sendIxs(conn, [admin], [buildSetVrfExpiryIx({ authority: admin.publicKey, expirySecs: VRF_EXPIRY_MIN_SECS - 1 })]));
    await rejects("admin set_vrf_expiry(604801)", /InvalidExpiry|0x17ac|6060/, () => sendIxs(conn, [admin], [buildSetVrfExpiryIx({ authority: admin.publicKey, expirySecs: VRF_EXPIRY_MAX_SECS + 1 })]));
    assert(!parseVrfExpiryInput("59", "minutes").ok && !parseVrfExpiryInput("604801", "seconds").ok, "UI parser bounds");
    let threw = false;
    try {
      buildSetVrfExpiryIxChecked({ authority: admin.publicKey, expirySecs: 3_599 });
    } catch {
      threw = true;
    }
    assert(threw, "checked builder should throw");
    ok("UI parser + checked builder refuse 59 min / 604,801 s client-side");

    // the owner's decision: 1 h, entered as minutes in the UI
    const r = parseVrfExpiryInput("60", "minutes");
    assert(r.ok, "parse 60 min");
    await set(r.secs);
    assert((await expiry()) === 3_600, "set 3600");
    assert(`${(await expiry()) / 60} min` === "60 min" && formatVrfExpiry(await expiry()) === "1 h", "tile text");
    ok("admin sets 60 minutes → Config 3,600 s; /admin tile reads \"60 min\"");

    await sendIxs(conn, [admin], [buildSetPausedIx({ authority: admin.publicKey, paused: true })]);
    await set(7_200);
    assert((await expiry()) === 7_200, "set while paused");
    await sendIxs(conn, [admin], [buildSetPausedIx({ authority: admin.publicKey, paused: false })]);
    ok("also works while the program is paused (launch-day setup runs paused)");

    await set(VRF_EXPIRY_MAX_SECS);
    assert((await expiry()) === VRF_EXPIRY_MAX_SECS, "max");
    await set(VRF_EXPIRY_MIN_SECS);
    assert((await expiry()) === VRF_EXPIRY_MIN_SECS, "min");
    ok("bounds themselves (3,600 s and 604,800 s) are accepted");

    await set(86_400);
    assert((await expiry()) === 86_400, "back to 86400");
    ok("set back to 86,400 s (24 h)");
    console.log(`[vrf-expiry] ${pass} checks passed`);
  } finally {
    ln.stop();
  }
}

// web3.js keeps re-opening its websocket after the validator stops; exit explicitly.
main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
