# GreenCat program: deploy, init order, Squads handover, SOL budget

Nothing here has been run against Devnet or Mainnet. Everything below was tested on a local validator only
(`apps/api/test/*-localnet.ts`). Numbers checked on 2026-09-30 PT.

## Toolchain

| Tool | Version used |
|---|---|
| anchor-cli | 0.31.1 (`~/.local/anchor-0.31.1/bin`) |
| solana-cli (Agave) | 4.2.2; cargo-build-sbf 4.1.0, platform-tools v1.54 |
| Crates | anchor-lang / anchor-spl `=0.31.1`, orao-solana-vrf `=0.6.1` (cpi only), mpl-token-metadata 5.1.1 (via anchor-spl) |

```bash
export PATH="$HOME/.local/anchor-0.31.1/bin:$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$PATH"
anchor build --no-idl                                                   # Devnet / localnet build → target/deploy/greencat.so
cargo build-sbf --manifest-path programs/greencat/Cargo.toml --features mainnet   # MAINNET build (pins $GC + Token-2022)
```

**Never deploy `--features localnet-short-windows`.** It is a test-only build that cuts the VRF-expiry and airdrop-window floors down to seconds
(`npm run anchor:build` creates it as `target/deploy/greencat-short.so` for the negative tests).

Cargo features:
- `mainnet`: `initialize_treasuries` only accepts `G2b4ZNxLjgTnVtPbuHpK9WXpccFCedoLYQ5uxvdEpump` owned by Token-2022 (GC-20).
- Default (Devnet/localnet): any mint. Init is still gated on the upgrade authority.

## External programs (already deployed on Devnet and Mainnet; nothing to create)

| Program | Address | Notes |
|---|---|---|
| ORAO VRF v2 | `VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y` | Network state PDA `["orao-vrf-network-configuration"]`; treasury `9ZTHWWZDpB36UFe1vszf2KEpt83vwi27jDqtHQ7NSXyR`. Request fee read on-chain 2026-09-30: **Devnet 0.0003 SOL, Mainnet 0.0005 SOL**. The SDK and scripts read the treasury from the network state, so nothing needs configuring. |
| Metaplex Token Metadata | `metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s` | Collection NFT plus each item |

Localnet: the tests load `tests/fixtures/orao_vrf.so` and `mpl_token_metadata.so` and call ORAO's own `init_network`
with a test treasury and fulfillment key, then fulfil requests themselves with an Ed25519 signature (ORAO's documented test approach). No mock code ships in the program.

## Init order (Devnet; Mainnet is identical, but run it from the multisig)

| # | Step | Who signs | Command | CU |
|---|---|---|---|---|
| 1 | Deploy as an **upgradeable** program | deployer (becomes the upgrade authority) | `solana program deploy target/deploy/greencat.so --program-id keys/greencat-program.json -u devnet` | n/a |
| 2 | `initialize_treasuries`: Config + 6 pool ATAs. **Only the program's upgrade authority** can do this (checked via ProgramData), so front-running is impossible. | upgrade authority | `GC_MINT=<mint> TOKEN_PROGRAM=spl\|token2022 KEYPAIR_PATH=<upgrade-auth.json> RPC_URL=… npm run init-treasuries` | 400k |
| 3 | `initialize_collection`: Collection account (2,824 B, rarity bitmap built from `greencat-meme-collection-v1`) | Config.authority | `METADATA_BASE_URI=ipfs://bafybeihq3n4h2756mmonwi5ckia3vztc47zuzcglx5dqxmt6dfk2zmzap4/ npm run init-collection` (runs 3 + 4 + optional 5). **`METADATA_BASE_URI` must be set** to this base; otherwise the script falls back to `https://www.greencat69420.com/nft/`. The base can never be changed later. | 1.4M |
| 4 | `create_collection_nft`: sized, verified collection NFT; update authority = `nft_authority` PDA | Config.authority | (same script) | 400k |
| 4b | `init_mint_pool` ×4: the zero-copy MintPool PDA `["mint_pool"]` (32,296 B: remaining ids `u16[10000]` + a 256-slot reveal queue). **Permissionless**, grows ≤10 KiB per call (all 4 steps fit in one tx). `mint_nft` fails until it's ready. Rent ≈ 0.2257 SOL. | anyone | (same script), or `npm run reveal -- init-pool` | 4×~30k |
| 5 | `set_royalty(bps ≤ 1000, recipient)`. Only possible **before the first mint**. Program default is 500 bps to the nft_fee_treasury PDA (optional on Devnet). **Mainnet: required, recipient = owner wallet `13zewBMqmpvv9oJWaqBRn9ww59h6qBh7z5XNpowyfyj6`** (owner decision 2026-10-02); `init-collection` does it automatically on mainnet and refuses other recipients. | Config.authority | `ROYALTY_BPS=500 ROYALTY_RECIPIENT=<addr> npm run init-collection`, or `npm run admin -- royalty <bps> <addr>` | 200k |
| 6 | Fund pools: long_rewards, daily_rewards, airdrop (no wheel bank: wheel removed Oct 12, 2026). **Mainnet: skip at launch** (owner decision Tue Oct 20, 2026 PT): no $GC goes into any app pool at launch; the 100M airdrop pool is funded only when the airdrop is set up for claims, staking pools only after the airdrop is complete. | anyone | `POOL_ID=0 AMOUNT_UI=… npm run deposit-treasury` | n/a |
| 7 | *optional* `set_vrf_expiry(3600…604800 s)` | Config.authority | `npm run admin -- vrf-expiry 86400` (**mainnet: `vrf-expiry 3600`**, owner decision 2026-10-03 PT; set after step 8 by the admin wallet `13zew…fyj6`, via the `/admin` **VRF expiry** panel (MetaMask can't sign the CLI). It also makes unanswered wheel spins refundable after 1 h) | n/a |
| 8 | Hand Config admin to the owner's wallet `13zew…fyj6` (`npm run admin -- propose <wallet>`, then **Accept authority** in `/admin`). Squads is no longer planned (see below). | n/a | n/a | n/a |
| 9 | **Staking switch: leave it Locked at launch.** `initialize_treasuries` writes `staking_enabled = false`, so a new deployment refuses `stake_daily` / `add_daily` / `stake_long` (`StakingLocked`) until the admin calls `set_staking_enabled(true)`. Mainnet: no tokens in the daily/365-day staking pools at launch; pools funded and staking opened only after the launch airdrop is fully complete (claim window ended + unclaimed tokens reclaimed; owner decision 2026-10-20 PT, replaces the 2026-10-07 "when claims open"), via `/admin` → **Staking: Locked** panel → **Open staking** → **Confirm: open staking**. | Config.authority | `/admin`, or `npm run admin -- staking open\|lock` (key file / `PRINT_ONLY=1`) | n/a |

## Instant per-mint reveal (since 2026-10-02)

There is no collection-wide reveal any more (`request_reveal` / `finalize_reveal` / `reveal_nft` were removed). Each NFT is revealed seconds after its mint:

1. `mint_nft` takes the $GC, mints the NFT with a short-lived placeholder (`GreenCat Mint #N`, `{base}unrevealed.json`), puts it in reveal-queue slot
   `mint_index % 256` and requests **one ORAO VRF per mint** (seed = `sha256("greencat-mint-vrf-v1" ‖ program ‖ nft_mint ‖ attempt)`; the buyer pays the ORAO fee).
2. When ORAO has fulfilled, **anyone** calls `settle_mint` for the **queue head** (strict FIFO: `mint_index == revealed_count`). It picks
   `j = u64(sha256(domain ‖ randomness ‖ nft_mint)) % remaining`, takes the id at `j` from the MintPool by swap-and-pop (no repeats), and writes
   `GreenCat #id` + `{base}{id}.json`. The web app sends the mint (one approval), then asks for this settle as soon as the oracle answers (a second, normal approval; nothing is pre-signed because the settle cannot simulate before the mint lands, which wallets like MetaMask flag as "reverted during simulation"). The CLI auto-settles.
3. Why it can't be sniped: the id depends on randomness nobody knows when they pay; the remaining pool each NFT draws from is fixed by mint order
   (FIFO, so you can't delay your settle to wait for a better pool); a fulfilled request can never be re-requested.
4. If ORAO doesn't fulfil within `vrf_expiry`, anyone re-requests with `request_mint_vrf` (attempt+1, passing the old request to prove it's unfulfilled).
   The same instruction gives legacy NFTs (minted before the upgrade) their first request.
5. At most 256 mints can be waiting (`MintQueueFull`); run `npm run reveal -- crank` as a safety net if users don't settle.
   Run it with a dedicated `RPC_URL` (the public endpoint rate-limits hard) under a supervisor that restarts it. If the **head** request is
   never fulfilled, every later mint waits until `vrf_expiry_secs` passes and the crank re-requests it (1 h: Devnet set to 3,600 s on 2026-10-03 PT, and the same on mainnet by owner decision;
   the wheel that also used it was removed). Devnet drill results: `docs/ORACLE-STALL-DRILL-2026-10-03.md`.

`npm run reveal -- status | init-pool | request | settle | crank [SECS]`; `npm run admin -- status` prints Config.

### Upgrading an existing deployment to instant reveal
The Config and Collection layouts are unchanged (old reveal fields are legacy; `revealed_count` is now the queue head), so the upgrade keeps
admin / pending handover, royalty, price and counts. Order: `solana program extend <PID> <new_len - old_len>` (the new binary is 1,062,888 B; +15,008 B
over the 1,047,880 B one) → `solana program deploy … --program-id <PID>` → `npm run reveal -- init-pool` → `-- request` (legacy NFTs) → `-- settle`.
Done on Devnet 2026-10-02 PT (5 legacy NFTs revealed). `apps/api/test/upgrade-migration-localnet.ts` rehearses this against the old binary.

**SBPF caveat:** the build is SBPF v0. SIMD-0500 (`B8JJXCy5amZyWG9r7EnUYLwzXSXTxG7GZ1qZ1qggo83g`, disables deploying v0–v2) is **inactive on Devnet and
Mainnet as of 2026-10-02** (re-checked 2026-10-03 ~17:15 PT before the staking-switch upgrade: still inactive on both). Once it activates, every further upgrade needs an SBPF v3 build (`--arch v3` / newer platform tools). Re-test before relying on it.

## Squads v4 handover (documented only; no multisig was created)

> **Owner decision 2026-10-02 PT: no Squads on mainnet.** Config admin = the owner's wallet `13zewBMqmpvv9oJWaqBRn9ww59h6qBh7z5XNpowyfyj6`; upgrade authority still open (see `docs/MAINNET-LAUNCH-CHECKLIST.md` Phase 2). This section is kept for reference only.

Recommended setup:
- **Multisig A** holds the **upgrade authority**. For example 3-of-5 hardware keys with `timeLock` = 48–72 h, so users can exit before a malicious upgrade lands.
- **Multisig B** (or A) is **Config.authority**, with a shorter time lock (e.g. 0–12 h). Squads v4's time lock applies to *every* vault transaction, including `set_paused`, so a 72 h lock makes the emergency pause useless.

  Config.authority's powers are bounded on-chain:
  - withdraw floors: long bonus owed, airdrop reserve (wheel reserve always 0 now)
  - capped house edge, bet, VRF expiry and royalty
  - no access to staking principal or escrows

  The remaining rug surface is the *unreserved* pool balances (mint proceeds, fees, any leftover wheel bank balance). Publish a treasury policy.

Steps (`<VAULT>` = the Squads vault PDA, index 0):
1. Create the multisig in the Squads app (members, threshold, time lock) and note the vault address. *Not done here.*
2. **Config admin (two-step, GC-19):**
   - Current EOA admin: `npm run admin -- propose <VAULT>`
   - Print the accept instruction: `PRINT_ONLY=1 AUTHORITY=<VAULT> npm run admin -- accept`
   - Create a Squads vault transaction from the printed `{programId, keys, data}` and approve and execute it.
   - Until it is accepted, the old admin stays in control and can cancel with `propose 11111111111111111111111111111111`.
   - After the handover, use `PRINT_ONLY=1 AUTHORITY=<VAULT> npm run admin -- pause|unpause …` for every admin action.
3. **Upgrade authority:** `solana program set-upgrade-authority <PROGRAM_ID> --new-upgrade-authority <VAULT> --skip-new-upgrade-authority-signer-check -u <cluster>`.
   Double-check the vault address first: a wrong address bricks upgrades.
4. Future upgrades:
   - `solana program write-buffer target/deploy/greencat.so` → `solana program set-buffer-authority <BUFFER> --new-buffer-authority <VAULT>`
   - Then a Squads "program upgrade" transaction (upgrade from buffer).
   - The buffer needs the same ~7.3 SOL as the deploy, refunded on upgrade.
5. Alternatively, for mainnet, the cleanest order is: deploy → step 3 (vault becomes the upgrade authority) → run `initialize_treasuries` **as a Squads vault transaction**. The vault is then Config.authority from the start, and no EOA ever holds admin.
6. Delete the dev `keys/*.json` from shared machines. Never use them on mainnet.
7. Later, optionally `solana program set-upgrade-authority <PID> --final` (irreversible) once the audit is done and the program has run safely.

## Staking switch (since 2026-10-03)

`Config.staking_enabled` + `Config.staking_flag_set` (two bytes taken from the old `_reserved`, so `Config::LEN` stays 312 B and no
migration ix is needed). Rule: staking is open when `!staking_flag_set || staking_enabled`.

- **New deployments start Locked:** `initialize_treasuries` sets flag = 1, enabled = 0.
- **Existing deployments stay Open after an in-place upgrade:** a Config written by an older binary has both bytes 0. The first
  `set_staking_enabled` call writes the flag, and from then on it behaves exactly like a new deployment.
- `set_staking_enabled(enabled: bool)`: admin only (`AdminConfig`, `has_one = authority`, else `Unauthorized`); emits `AdminAction { action: 9 }`.
  The upgrade authority can't toggle it unless it's also the Config authority. Works while paused.
- Gated (`StakingLocked`, 6086): `stake_daily`, `add_daily`, `stake_long`. **Never gated:** `unstake_daily`, `claim_daily`, `claim_long`.
  So existing positions can always claim and unstake (subject only to their own 24 h / 365-day locks and the pause rules below).
- UI: `/admin` panel **Staking: Locked / Open** (button → confirm box → one wallet approval); `/stake` keeps the pools visible, disables the
  stake buttons and shows "🔒 Staking opens after the launch airdrop is complete"; claim/unstake buttons stay live.
- Devnet: upgraded in place 2026-10-03 17:29:54 PT (tx `5oxJmjck…2dcL`, binary 1,065,208 B, sha256 `bbf50bc9…f031`). The pre-upgrade Config reads
  as **Open** (flag not set), so Devnet staking kept working with no admin action.
- Upgrade note: `solana program extend` now refuses less than **10,240 bytes** (this binary grew only 2,320 B; we extended by 10,240).
  Rehearsal: `OLD_SO=<dumped old binary> npm run test:staking-switch -w @greencat/api`.

## Cat Fight (removed Oct 12, 2026 by owner)

The Cat Fight module and its instructions were removed from the program, SDK, web, scripts and CI. Old docs: [`archive/catfight/`](archive/catfight/). Code: git tag `catfight-final`.
- Devnet upgraded 2026-10-12 ~9:52 AM PT to the Cat-Fight-free binary (1,065,208 B, sha256 a258b623…eb873), tx `3oCFjkj4uTYKjgrr1RQVhmLyrimCdWhyr4NGCMJyLL9n8L9EDqwJe65PdNfvzX2Jc5ad3p828Fc9xdE4Ytj8fZxx`, 0.0056 SOL. ProgramData stays 1,280,360 B (cannot shrink). Rollback: `/workspace/rollback/greencat-pre-catfight-removal.so`.
- Orphaned on devnet: Cat Fight config `G11mkuNp…`, 5 round PDAs, 2 round-3 bet PDAs (2GXR2X44… Blue 300 GC unclaimed win ≈ 4,275 GC; J3Gaamh5… Red 200 GC loser), bet vault `58a9TQjU…` 4,275.000001 GC, fee vault `FiZGCRtq…` 800 GC; ≈0.0153 SOL rent. No instruction can move them now.
- Mainnet build without Cat Fight: 1,067,024 B → rent ≈ 5.4214 SOL (was ≈ 8.91 SOL for 1,279,736 B).

## Wheel (removed Oct 12, 2026 by owner)

`request_spin` / `settle_spin` / `refund_spin` / `set_wheel_params` and `wheel.rs` are gone (admin action 3 retired, wheel error codes kept in place so other codes don't shift). Config `wheel_*` fields stay for layout (new deployments start them at 0). The `wheel_bank` pool PDA (pool id 2) is still created by `initialize_treasuries` and can still be withdrawn by the authority. Archive: [`archive/wheel/`](archive/wheel/). Last code: git tag `wheel-final`.

## Community chat (removed Oct 12, 2026 by owner)

Web `/chat` redirects to `/`; API `/chat/*` routes, chat config/env, SDK methods and tests removed. Migrations 003/004 and the chat tables/data are kept on purpose. Archive: [`archive/chat/`](archive/chat/). Last code: git tag `chat-final`.

## Pause semantics (GC-19)

`set_paused(true)` blocks every user *entry*:
- mint_nft, settle_mint, request_mint_vrf (init_mint_pool stays open: it only allocates)
- list_nft, buy_nft, make_offer, accept_offer
- stake_daily, add_daily, claim_daily, stake_long
- deposit_treasury, claim_airdrop

These **stay open while paused** (they only return the caller's own funds, or are bounded admin actions):
- cancel_listing, cancel_offer
- unstake_daily (principal only; rewards are skipped while paused)
- claim_long (principal only; the bonus is skipped while paused)
- all admin setters; `withdraw_treasury`, which respects the floors (`create_airdrop` is the one admin action blocked while paused)

`reclaim_airdrop` requires *not paused* and ≥ 3 days since the last pause change, so a pause can't be used to run out a claim window.

## SOL budget for Devnet (deploy + init)

The rent figures come from the validator (`getMinimumBalanceForRentExemption`). The init and user costs were **measured on localnet**
(`npx tsx apps/api/test/measure-costs-localnet.ts`, Token-2022 $GC).

| Item | SOL | Notes |
|---|---:|---|
| Deploy buffer (1,047,917 B) | 7.294 | Written first. In `DeployWithMaxDataLen` the loader **drains the buffer to the payer before funding program data** (Agave `bpf_loader`, "Drain the Buffer account to payer before paying for programdata account"), so the buffer and program-data rent are **not** needed at the same time. |
| Program-data account (1,047,880 B `.so` + 45 B header, max-len = 1×) | 7.294 | Paid from the drained buffer (net +0.00006 SOL). Locked while the program exists; recoverable with `solana program close`. |
| Program account (36 B) | 0.001 | |
| Deploy write transactions (~1,050 × 5,000 lamports) | ~0.006 | Plus priority fees if you add any |
| `initialize_treasuries` (Config 312 B + 6 pool ATAs) | 0.0155 | measured |
| `initialize_collection` (Collection 2,824 B) | 0.0206 | measured |
| `create_collection_nft` (mint, metadata, master edition, ATA) | 0.0197 | measured |
| Admin txs (royalty, deposits, handover) | ~0.001 | 5,000 lamports each |
| Devnet test $GC mint + a few ATAs | ~0.01 | |
| **Minimum to deploy + init** | **≈ 7.36** | Almost all of it stays locked in program data |

**Corrected 2026-09-30 21:55 PT.** An earlier version of this doc said "≈ 14.7 SOL peak / ~16 SOL". That double-counted the buffer, which the loader recycles into program data.
- `solana program deploy` already defaults `--max-len` to the exact program length (Agave 4.2 help: "default: the length of the original deployed program"), so passing `--max-len <exact size>` changes nothing.
- A larger `--max-len` (e.g. 2× for upgrade headroom) costs ≈ 7.29 SOL more for program data (≈ 14.6 SOL total).

**Recommendation: ~8 SOL on the Devnet deployer.** That is ≈ 7.36 SOL to deploy and init, plus ~0.3–0.6 SOL for smoke tests: a few mints at 0.021 each, spins, stake and airdrop accounts. Each later upgrade needs a temporary ≈ 7.3 SOL buffer (refunded to the spill account when the upgrade completes), or you can first run `solana program extend` if the binary grows.

Per-action costs paid by users (useful for test-wallet funding):
- `mint_nft`: ≈ 0.0282 SOL (NFT mint, metadata, master edition, ATA, NftRecord + ORAO request rent and fee); ≈ 0.024 SOL net after ORAO refunds excess rent on fulfil. `settle_mint`: tx fee only.
- `request_spin`: ≈ 0.0078 SOL rent + ORAO fee (0.0003 Devnet / 0.0005 Mainnet). The SpinRequest rent comes back on settle/refund. The ORAO fee and the ORAO request account rent do not.
- `init_mint_pool`: ≈ 0.2257 SOL once (MintPool rent). `request_mint_vrf`: ≈ ORAO fee + request rent (legacy NFTs / expired requests only)

Mainnet needs the same rent amounts: ≈ 7.4 SOL to deploy + init (plus priority fees), and a temporary ~7.3 SOL buffer for each future upgrade.
