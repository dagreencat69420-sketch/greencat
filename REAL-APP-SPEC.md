# GreenCat Holder App — Real App Spec (v1)

Status: treasuries + mint + marketplace + staking + airdrop + **Cat Wheel** live locally/devnet (2026-09-25). Wheel mainnet is **legal-gated**. Polish scaffolds (2026-09-26 PT): metadata pipeline docs, marketplace indexer stub, ToS/legal drafts, **engagement Points** (client-local). Demo at `greencat-holder-app.vercel.app` remains the UX reference. This doc is the target for the on-chain product.

> **Superseded in parts by the security audit, round 2 (2026-09-30 PT).** Where this spec disagrees with `docs/SECURITY-AUDIT-PREP.md` / `docs/DEPLOY.md`, those win:
> - Wheel = ORAO VRF request → settle (anyone) / refund (expired + unfulfilled only), house edge 3% (≤ 10%), bets 10–50,000 GC; **`spin_wheel` and SlotHashes RNG removed**.
> - Mint = unrevealed mint + one-seed VRF reveal after sell-out or `close_mint`; NFT update authority = program PDA, verified collection, 500 bps royalty.
> - Airdrop = Merkle snapshot + claim (`create_airdrop` / `claim_airdrop` / `reclaim_airdrop`); `prepare/run/cancel_airdrop_prep` removed.
> - Admin = two-step handover, pause, withdraw floors; init only by the upgrade authority; `buy_nft(expected_price)`, `accept_offer(min_amount)`.
> - Scripts are now `scripts/*.ts` (`npm run init-treasuries|init-collection|mint-nft|list-nft|buy-nft|reveal|admin|airdrop`); smoke tests are `apps/api/test/*-localnet.ts`.

## Goal

Ship a **real Solana app** that preserves the demo product surface:

1. Wallet + live `$GC` (SPL) balance  
2. 10k GreenCat NFT mint + secondary marketplace (1% fee)  
3. Daily staking + 365-day tranche staking  
4. Cat Wheel (wallet `$GC` bets / payouts)  
5. Lo-fi player + community chat (off-chain OK)  
6. Admin treasury / analytics (multisig + secured backend)  
7. Engagement **Points** (display-only — never spendable / never convertible to `$GC`)

Token CA (mainnet, pump.fun launched): `G2b4ZNxLjgTnVtPbuHpK9WXpccFCedoLYQ5uxvdEpump`

**Canonical token:** the real app uses this existing mainnet mint only (Token-2022, 6 decimals). Do not deploy a replacement meme mint for production.

## Non-negotiables

- **Non-custodial by default.** Users connect Phantom / Solflare / Backpack. The app never holds user private keys. Demo “deposit address + simulate” goes away for users.
- **All money moves are on-chain instructions** (or clearly labeled off-chain social features only: chat, music).
- **Keep demo UX.** Mint unwrap/carousel/rarity SFX, wheel animation timing, stake claim/add, neon brand, faceless mascot-only.
- **No “guaranteed returns” copy.** 365-day bonus stays promotional / pool-funded wording.
- **Audit before mainnet** for stake vaults + wheel. Wheel is gambling-adjacent — legal review required before public mainnet launch of that feature.

## Architecture

```
[Browser Next.js] --wallet-adapter--> [Solana programs (Anchor)]
       |                                      |
       |-- RPC / Helius ----------------------|
       |
       +--> [API + DB] chat, indexer cache, admin auth, geo/age gates
       |
       +--> [Admin] Squads / multisig + ops dashboard
```

| Layer | Choice | Why |
|-------|--------|-----|
| Frontend | Keep Next.js 14 + TS + Tailwind; add `@solana/wallet-adapter` | Reuse demo UI |
| Programs | Anchor (Rust) on Solana | Standard for vaults / mint / escrow |
| NFT standard | **Metaplex Token Metadata** (Master Edition) | Phantom-visible NFTs; cNFT deferred |
| Token | Existing SPL `$GC` mint (CA above) | No new meme mint |
| Randomness (mint pick + wheel) | On-chain VRF (Orao / Switchboard) for wheel; for mint either VRF or commit–reveal / merkle “unminted set” | Client `Math.random` is not acceptable when money moves |
| Indexer | Helius webhooks → Postgres (or Supabase) | Fast marketplace browse, admin stats |
| Hosting | Vercel (app) + managed DB + Solana RPC paid tier | Same deploy muscle as demo |
| Admin authority | Squads multisig (2-of-3+) over program upgrade + treasury PDAs | Never single hot key in browser |

## On-chain modules (design all now; deploy in order)

### A. Treasuries (PDAs) — **IMPLEMENTED** (2026-09-25)

Named vaults matching demo pools. On-chain: `Config` PDA + 6 treasury authority PDAs + Associated Token Accounts for `$GC` (Token-2022 aware via `token_interface`).

| pool_id | PDA seed | Funds | Authority |
|---------|----------|-------|-----------|
| 0 | `daily_rewards` | Pays daily claim | Program + admin top-ups (`deposit_treasury` anyone / `withdraw_treasury` authority) |
| 1 | `long_rewards` | Pays 365d promotional bonus | Same |
| 2 | `wheel_bank` | Pays wins; receives losses | Same |
| 3 | `nft_fee_treasury` | 1% secondary fees | Same |
| 4 | `mint_proceeds` | Receives 10,000 `$GC` per mint | Same |
| 5 | `airdrop` | Holder airdrop pool (even split) | Admin: `set_airdrop_threshold` + `prepare_airdrop` + `run_airdrop` batches |

**Instructions (live):** `initialize_treasuries`, `deposit_treasury(pool_id, amount)`, `withdraw_treasury(pool_id, amount)`, `set_airdrop_threshold`, `prepare_airdrop`, `run_airdrop`, `cancel_airdrop_prep`.  
**Units:** all u64 amounts are **raw** token amounts (UI × 10^decimals). Mainnet $GC = Token-2022, 6 decimals → 1 UI = 1_000_000 raw.  
**Defaults at init (raw):** airdrop_min = 100_000×10^6; daily/wheel allowances = 20_000_000×10^6; long capacity = 100_000_000×10^6.

Caps mirror demo (stored on `Config`, enforced by later stake/wheel slices):

- Daily: lifetime reward payout allowance (seed 20M `$GC`)  
- Wheel: lifetime wins paid allowance (seed 20M) + bank must cover max win (10× bet)  
- 365: site principal capacity (seed 100M)

Scripts: `scripts/initialize-treasuries.mjs`, `deposit-treasury.mjs`, `withdraw-treasury.mjs`, `derive-treasury-pdas.mjs`.

### B. Wallet / identity

- Auth = connected wallet pubkey (optional SIWS session for chat/admin API).  
- Drop username/password demo accounts for money features.  
- Display name for chat can stay off-chain profile keyed by wallet.

### C. NFT collection + mint — **IMPLEMENTED** (2026-09-25) (VRF mint = TODO)

Preserve catalog rules from demo — now on-chain:

- 10,000 ids; rarity bag Legendary 1% / Rare 9% / Uncommon 20% / Common 70%  
- Deterministic rarity from catalog seed `greencat-meme-collection-v1` (Fisher–Yates / mulberry32 — Rust + SDK match demo `nftCatalog.ts`)  
- Mint price **10,000 `$GC`** (raw `10_000 * 10^6`) Token-2022-aware transfer into `mint_proceeds` (pool_id 4)  
- **NFT standard:** Metaplex Token Metadata + Master Edition (`max_supply = 0`); classic SPL mint decimals=0 for the NFT; $GC payment stays on Token-2022 interface  
- `Collection` PDA (`seeds = ["collection"]`, zero-copy, 3928 bytes): minted bitmap (10k bits), packed rarity (2 bits/token, filled at init), `minted_count`, `mint_price_raw`, `metadata_base_uri` (default `https://www.greencat69420.com/nft/`)  
- **Random unminted id (shipped):** `Clock` + `SlotHashes` → `randomness::mint_entropy_from_parts` → bitmap walk — **must not mint duplicates**; client never passes token id  
- **VRF mint (TODO):** same provider as wheel; feed fulfilled 32 bytes into `pick_unminted_from_entropy` (helpers already shared). Optional commit–reveal if two-phase mint CU is too heavy.  
- Sold out when `minted_count >= 10000`  
- `initialize_collection` (authority); `mint_nft` (buyer + client mint keypair); emits `NftMinted { token_id, rarity, buyer, mint }` for unwrap/reveal SFX  
- Metadata URI: `{base}{id}.json` — off-chain pipeline scaffolded (`docs/METADATA-PIPELINE.md`, `scripts/generate-metadata.mjs`, EXAMPLE JSON under `metadata/`); art **not** uploaded yet  
- Scripts: `initialize-collection.mjs`, `mint-nft.mjs`, `smoke-mint-local.mjs`  
- Web: Mint panel (disabled when collection not initialized on cluster)

### D. Marketplace — **IMPLEMENTED** (2026-09-25)

Demo parity fee rules (see holder-app `src/lib/marketplace.ts` / DEMO-NOTES):

- **Fee bps = 100 (1%).** Integer floor: `fee = price * 100 / 10000`, `seller_net = price - fee`. Buyer always pays the full list/offer price.  
- **List** (`list_nft(price)`): escrow classic SPL NFT into ATA owned by `Listing` PDA `seeds = ["listing", nft_mint]`.  
- **Cancel listing** (`cancel_listing`): seller only; NFT returned from escrow; listing closed.  
- **Buy** (`buy_nft`): buyer pays full price in `$GC` (Token-2022-aware); seller nets 99%; 1% → `nft_fee_treasury` vault; NFT → buyer; listing closed.  
- **Offers:** `make_offer(amount)` escrows `$GC` in ATA owned by `Offer` PDA `seeds = ["offer", nft_mint, bidder]`; `cancel_offer` (bidder); `accept_offer` (owner) same 1% split, NFT → bidder, active listing cancelled if any.  
- Primary **mint is not fee’d** (full price → `mint_proceeds`).  
- Requires config not paused; treasuries + collection as needed for mint path.  
- SDK: fee helpers + PDA + ix builders. Scripts: `list-nft.mjs`, `buy-nft.mjs`, `smoke-marketplace-local.mjs`. Web: Marketplace panel (disabled when program not on cluster).  
- Indexer browse/sort: **spec + local stub** (`docs/INDEXER.md`, `apps/indexer`) — Postgres/Helius wiring still TODO.

### E. Daily staking — **IMPLEMENTED** (2026-09-25)

Demo parity (holder-app `economy.ts` / DEMO-NOTES):

- Accrual rate `0.0136986301%` of principal per 24h → on-chain `DAILY_RATE_NUM / PENDING_SCALE` with `PENDING_SCALE = 1e12`, `DAILY_RATE_NUM = 136986301`  
- Lazy accrual on user ixs: `periods = floor((now − last_accrual_ts) / 86400)`; pending stored as `pending_scaled` (u128); **floor to whole raw** on claim  
- `DailyStake` PDA `seeds = ["daily_stake", user]`; principal custody in ATA owned by `daily_principal` PDA  
- Instructions: `stake_daily`, `add_daily`, `claim_daily` (claim to wallet only — no compound), `unstake_daily` (min 24h from `started_at`)  
- Payouts debit `daily_rewards`; increment `config.daily_lifetime_paid` vs `daily_payout_allowance`  
- Lock new stake/add when remain payout ≤ 0; claim/unstake auto-claim `pay = min(floor(pending), pool, remain)` to wallet  
- Config fields: `daily_lifetime_paid`, `long_staked` (LEN 176)

SDK: `packages/sdk/src/stake.ts` + ix builders. Smoke: `npm run smoke-stake`. Web: Stake panel (disabled if config missing).

### F. 365-day staking — **IMPLEMENTED** (2026-09-25)

- Each deposit = `LongTranche` PDA `seeds = ["long_tranche", user, tranche_id]` with `unlock_at = start + 365d`  
- `LongState` PDA tracks `next_tranche_id`; add-to-stake = **new tranche** (pass `tranche_id == next_tranche_id`) — no timer reset  
- Capacity: `config.long_staked + amount ≤ long_stake_capacity`  
- Principal in ATA owned by `long_principal` PDA  
- `claim_long(tranche_id)` after unlock: return principal + `min(bonus_owed, long_rewards pool)` (target bonus = 100% of principal at stake time — **promotional / not guaranteed**; residual `bonus_owed` stays claimable)  
- Copy must not say “guaranteed 100%”

### G. Cat Wheel (highest risk) — **IMPLEMENTED two-phase** (2026-09-25; mainnet legal-gated)

**Demo parity:** 10 segments (seed.ts); index **4 = WIN 10×**; rest MISS. Odds ≈ 1/10 at 10×.

**Shipped ix flow (VRF-ready architecture):**
1. `request_spin(bet, nonce)` — locks (same rules), debit bet → `wheel_bank`, init `SpinRequest` PDA  
   `seeds = ["spin_request", player, nonce]` (status pending). Emits `SpinRequested`.  
2. `settle_spin(nonce)` — entropy bound to that PDA → segment; win/loss settle; close PDA (no replay).  
   Emits `WheelSpun { player, bet, segment, won, payout }`. Client **never** passes segment.  
3. Legacy `spin_wheel(bet)` — one-shot SlotHashes path, compiled only with feature `slot-hashes-rng` (default) for local smoke/UI fallback.

**Cash flow (unchanged math):**
- **Win:** credit `bet * 10` from vault → player; `wheel_lifetime_paid += bet*10` (bank net −9×bet).  
- **Loss:** bet stays in bank; `wheel_lifetime_lost += bet`.

**Locks (at `request_spin`, before accepting bet):**
- `wheel_lifetime_paid + (10*bet) > wheel_payout_allowance` → `WheelLocked`  
- Bank cannot cover max win **including** incoming bet: `bank + bet < 10*bet` ⇒ `bank < 9*bet` → `WheelLocked`

**Config fields (LEN 208):** `wheel_lifetime_paid`, `wheel_lifetime_lost`.

**Randomness (honest status):**
- **Shipped local/Devnet-without-oracle:** feature `slot-hashes-rng` (default) fulfills `settle_spin` via Clock + SlotHashes, hashed with `SpinRequest` key + player + bet + nonce (`programs/greencat/src/randomness.rs`).  
- **Provider chosen for production:** **Orao VRF** preferred (clean CPI once Anchor ≥0.31); Switchboard On-Demand as alternate. Both current crates fight **Anchor 0.30.1** — we did **not** vendor-lock a half-broken dep. CPI stubs + next steps live in `randomness::{orao_stub,switchboard_stub}` and `scripts/smoke-wheel-vrf-devnet.md`.  
- **TODO before mainnet:** wire Orao (or Switchboard) fulfill into `settle_spin` remaining_accounts; build without relying on SlotHashes for prod; legal gate.

**Public UI:** hides bank balance / allowance numbers (admin only) — same as demo. Web uses request+settle in one tx locally.

**Compliance (must decide before mainnet wheel):**

- Many regions treat token wagering as gambling.  
- Age gate (18+/21+), geo-blocking, ToS, “no real fiat casino” framing is **not** enough alone.  
- **Mainnet launch is legal-gated.** Ship wheel **devnet/local-only** until counsel signs off; other modules may go mainnet earlier.

### H. Off-chain (keep from demo)

- Lo-fi player / PWA  
- Community chat (wallet-signed messages, moderated backend)  
- Admin analytics dashboard (indexed + RPC)

### I. Airdrop pool (from DEMO-NOTES) — **IMPLEMENTED** (2026-09-25)

- PDA `airdrop` treasury (pool_id **5**) — admin deposit/withdraw like other pools.  
- Threshold `airdrop_min_holding`: min **liquid** wallet `$GC` (staked principal not counted). Default **100,000** UI.  
- **On-chain constraint:** cannot scan all wallets in one program. Authority submits recipient **$GC ATAs** via `remaining_accounts`.  
- **Option A (shipped):** every remaining ATA must already qualify (`amount ≥ airdrop_min_holding`); else `RecipientBelowThreshold`.  
- **Prepare + batch (fair multi-tx split):**
  1. `prepare_airdrop(qualifier_count)` — authority-only; require `n > 0`, vault > 0, `per = floor(vault/n) > 0`; store `airdrop_per_user` + `airdrop_remaining_slots` on `Config`; **does not move tokens**. Errors: `EmptyAirdropPool`, `NoQualifiers`, `ZeroPerUser`, `AirdropAlreadyPrepared`.
  2. `run_airdrop` — authority-only; remaining_accounts = recipient ATAs (max **20**/ix); each must be writable gc_mint token account ≥ threshold; pay exactly `airdrop_per_user` from airdrop vault (PDA signer); decrement slots; clear prep when slots hit 0. Remainder of snapshot stays in vault (`vault - per*n`).  
  3. `cancel_airdrop_prep` — clear prep without paying.  
- Large holder lists = multiple `run_airdrop` calls after one prepare (same fixed `per_user`).  
- SDK: `buildSetAirdropThresholdIx`, `buildPrepareAirdropIx`, `buildRunAirdropIx`, `buildCancelAirdropPrepIx`.  
- Smoke: `npm run smoke-airdrop`. Web: `AirdropPanel`.

### J. Engagement Points — **SHIPPED client-local** (2026-09-26 PT)

Display-only engagement score. **Never** spendable / convertible to `$GC` / never touches stake, wheel, mint, or market balances.

- Daily claim: random **1–100** once per America/Vancouver calendar day  
- Streaks + milestones 3/7/30 (+10/+25/+100 once per streak)  
- Activity: mint +15, stake open/add +10, list +10, wheel +5, lo-fi +1/~60s (cap 10/day)  
- Monthly reset on 1st Vancouver; **keep streak**  
- Leaderboard: rank **all** known wallets; UI **top 10** + always show current user’s rank/points  

**Persistence:** browser `localStorage` keyed by wallet (`PointsStore` interface in `@greencat/sdk`). Multi-device global board needs indexer/server later — see `docs/POINTS.md`. No on-chain PDA required for v1 UX; do not block on SOL.

## Environments

| Env | Purpose |
|-----|---------|
| Local / LiteSVM or `solana-test-validator` | Unit + integration tests |
| Devnet | Public test with airdropped test `$GC` clone or wrapped test mint |
| Mainnet | Production after audit + funded treasuries |

Keep current Vercel demo live as `demo.` or `/demo` until mainnet cutover.

## Build order (full suite designed; shipped in slices)

1. **Repo split:** `apps/web` (evolve current Next app) + `programs/` (Anchor) + `packages/sdk`  
2. **Wallet connect + live `$GC` balance + tx history** (read-only first)  
3. **Treasury PDAs + admin multisig top-up / withdraw**  
4. **Mint program + metadata + reveal UX wired to real txs** — done (VRF later)  
5. **Marketplace** — done  
6. **Daily stake** then **365 stake** — done  
6b. **Airdrop prepare + batch** — done  
7. **Wheel two-phase** shipped (SlotHashes fulfill local) — **Orao/SB CPI** + legal gate → mainnet  
8. **Chat / music polish**, monitoring, runbooks  

Parallel tracks: legal (wheel) — **DRAFT ToS** in `greencat-brand/legal/` + `docs/LEGAL-DRAFTS.md`; art/metadata pipeline scaffolded; indexer stub; treasury funding plan; audit vendor.

## Funding & ops (real `$GC`)

Before mainnet stake/wheel:

- Seed `daily_rewards`, `long_rewards`, `wheel_bank` with real tokens (sizes TBD vs market cap / runway).  
- Mint proceeds and NFT fees → multisig policy (buyback, LP, ops, rewards refill).  
- Publish addresses on greencat69420.com.

## Security checklist

- [ ] Anchor constraints + overflow checks on all vault math  
- [ ] No admin can rug user stake principal (authority limited to pool top-up / pause / cap bump)  
- [ ] Pause switches per module  
- [x] Wheel settlement on-chain (two-phase `SpinRequest`, no client segment)
- [x] PDA-bound entropy + no-replay close on settle (SlotHashes fulfill local)
- [ ] Orao / Switchboard VRF CPI (blocked on Anchor 0.30 → need ≥0.31 or vendored layouts)  
- [ ] Independent audit (stake + wheel mandatory)  
- [ ] Bug bounty after mainnet soft launch  
- [ ] Rate limits / geo middleware for wheel API if any off-chain gate  

## Rough effort (order-of-magnitude)

| Slice | Effort |
|-------|--------|
| Wallet + treasuries + mint | ~3–6 weeks |
| Marketplace | ~2–4 weeks |
| Both stake products | ~3–6 weeks |
| Wheel + VRF + gates | ~3–5 weeks |
| Audit + fixes | ~4–8 weeks calendar |
| Legal (wheel) | parallel, start immediately |

One strong Solana engineer (or small team) + frontend reuse. Calendar longer if solo.

## Open decisions (need user locks)

1. NFT standard: **locked — Metaplex Token Metadata** (not cNFT)  
2. Wheel: mainnet goal vs forever-devnet until counsel signs off  
3. Who holds multisig keys (how many people / hardware wallets)  
4. Initial treasury seed sizes in real `$GC`  
5. Domain: **locked — `app.greencat69420.com`** (owner decision 2026-10-03 PT)

## Success criteria (mainnet v1)

- User can connect wallet, see real `$GC`, mint a catalog NFT for 10k `$GC`, trade with 1% fee, stake daily and 365 per demo rules, and (if enabled) spin wheel with VRF-backed settlement.  
- Admin can fund/pause pools via multisig.  
- Demo disclaimers replaced with accurate mainnet ToS; wheel either live with legal controls or explicitly disabled.

## Product polish checklist (while Devnet SOL funding waits)

- [x] NFT metadata / art pipeline docs + EXAMPLE JSON + `scripts/generate-metadata.mjs` (`docs/METADATA-PIPELINE.md`)
- [x] Mint UI note: metadata not uploaded yet (links pipeline doc)
- [x] Marketplace indexer spec + local log poller stub (`docs/INDEXER.md`, `apps/indexer`) — no paid Helius required
- [x] Marketplace UI note: browse/sort waits on indexer
- [x] Mainnet ToS / Wheel / Privacy **DRAFTS** for counsel (`greencat-brand/legal/`, `docs/LEGAL-DRAFTS.md`)
- [x] Engagement Points (client-local) — SDK rules + web UX + activity wiring (`docs/POINTS.md`)
- [ ] Upload real art + pin IPFS/Arweave; point `metadata_base_uri` at final host
- [ ] Port full demo trait RNG into metadata generator (not EXAMPLE trait text)
- [ ] Indexer → Postgres + optional Helius webhooks; web browse API
- [ ] Counsel review + publish ToS; wire age/geo gates before mainnet Wheel
- [ ] Devnet deploy (blocked on authority SOL)
- [ ] Orao/Switchboard VRF CPI for production Wheel
- [ ] Audit (stake + wheel)

