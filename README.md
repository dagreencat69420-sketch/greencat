# GreenCat App (real Solana monorepo)

## About this project

GreenCat ($GC) is a community app on Solana built around the $GC token
(mint `G2b4ZNxLjgTnVtPbuHpK9WXpccFCedoLYQ5uxvdEpump`). This repository contains:

- **Anchor program** (`programs/greencat`): GreenCat NFT minting with on-chain VRF reveal, $GC staking, a merkle-proof airdrop claim, and an NFT marketplace.
- **TypeScript SDK** (`packages/sdk`): instruction builders, account decoders and helpers for the program.
- **Web app** (`apps/web`): Next.js front end for minting, staking, claiming airdrops and tracking points.
- **API / indexer** (`apps/api`, `apps/indexer`): Sign-In-With-Solana sessions, an on-chain activity indexer and the off-chain points system.
- **Scripts and tests**: admin/ops scripts, unit tests and localnet end-to-end tests.

Configuration is supplied through environment variables; see the `.env.example` files. No keys or credentials are included in this repository.


[![CI](https://github.com/dagreencat69420-sketch/greencat/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/dagreencat69420-sketch/greencat/actions/workflows/ci.yml)

> No key material is included: `keys/`, Solana keypair JSONs (`*-keypair.json`, `id.json`, `target/deploy/`), and all `.env*` files (except `.env.example`) are gitignored. Rendered art (`art/out/`), build output, and local ledger/DB data are also excluded.

Non-custodial Solana scaffold for the GreenCat holder product. The **client-side demo** remains at [greencat-holder-app.vercel.app](https://greencat-holder-app.vercel.app) — do not replace it with this repo yet.

Product lock: `REAL-APP-SPEC.md` (includes **airdrop** treasury PDA). Demo airdrop rules: holder-app `DEMO-NOTES.md`.

See [`docs/HOSTING.md`](docs/HOSTING.md) for public hosting of the API, indexer, and web (free and cheap tiers).

## Mainnet Deployment (Live — 2026-10-25)

| Item | Value |
|---|---|
| **Mainnet Web App** | [`https://app.greencat69420.com`](https://app.greencat69420.com) |
| **Mainnet Program ID** | `2pwrnxCswbq9cjgfRWQAMJUp6n1MRALpURLBjbmFURdc` |
| **ProgramData Account** | `AfF1zN8GqMHQotkeMT5QRMhk7PHNR81nkX1raJsB794e` |
| **`$GC` Token Mint (Token-2022)** | `G2b4ZNxLjgTnVtPbuHpK9WXpccFCedoLYQ5uxvdEpump` (`6` decimals) |
| **Config PDA** | `Hwog6h9ekbpatGnuZMxsfg2G9RmM62YJnv66trwfiXmt` |
| **Collection PDA** | `9sSWcZLCtLeEGkExmtVL6ruRJdqiiHckyzjZZDRKX24K` |
| **Collection Mint PDA** | `78qgzuHNRVPTUQM2ZZTwN8GntyfEy8uTfiVP7fXUyjFY` |
| **NFT Update Authority (`nft_authority`) PDA** | `EvTxFanrhmhUmTL1VaYsRobGSfh83vkSz3nM9ScsbtHz` |
| **MintPool PDA** | `AQrCkhgQQm5rez5cNX45j3KfCKcYMrKEvSBXLKfUcFoD` |
| **Upgrade & Config Authority** | `13zewBMqmpvv9oJWaqBRn9ww59h6qBh7z5XNpowyfyj6` |

## Layout

```
apps/web          Next.js 14 + Tailwind + wallet-adapter (mainnet & devnet)
apps/indexer      Local marketplace log poller stub (no Helius required)
packages/sdk      Shared constants / cluster helpers / points rules / generated mint config
programs/greencat Anchor program (treasuries, mint, market, stake, airdrop)
scripts/          Mainnet & devnet helpers + generate-metadata.mjs
metadata/         EXAMPLE Metaplex JSON samples (not production art)
docs/             METADATA-PIPELINE, INDEXER, LEGAL-DRAFTS, POINTS
keys/             Local keypairs (gitignored) — authority + program id
```

Mainnet `$GC` (Token-2022): `G2b4ZNxLjgTnVtPbuHpK9WXpccFCedoLYQ5uxvdEpump`  
Devnet uses a **classic SPL clone** created by the mint script (written to `packages/sdk/src/generated/devnet.json`).

## Prerequisites

- Node 20+
- Solana CLI (`solana`, `spl-token`, `cargo-build-sbf`) — often under `~/.local/share/solana/install/active_release/bin`
- Rust + Anchor CLI **0.31.1** (`Anchor.toml`), Agave/solana-cli 4.2.x (cargo-build-sbf 4.1, platform-tools v1.54)
- Devnet SOL on `keys/devnet-authority.json` for mint creation

```bash
export PATH="$HOME/.local/anchor-0.31.1/bin:$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$PATH"
solana config set --url devnet --keypair keys/devnet-authority.json
```

## Install

```bash
cd /workspace/greencat-app
npm install
```

## Create devnet $GC mint

```bash
# Fund authority if needed
solana airdrop 2 -k keys/devnet-authority.json --url devnet

npm run create-devnet-mint
# → packages/sdk/src/generated/devnet.json + apps/web/.env.local
```

Mint test tokens to a wallet:

```bash
npm run airdrop-gc -- <RECIPIENT_PUBKEY> [AMOUNT_UI]
# default amount 100000
```

## Run web (devnet)

```bash
npm run dev
# http://localhost:3001
```

Connect a wallet set to **devnet**. UI shows pubkey, SOL, and SPL `$GC` balance.
Engagement **Points** (display-only) live at `/points` — see `docs/POINTS.md`.

```bash
npm run build   # must pass
```

## Anchor program

For deploy, the init order, the Squads handover and the SOL budget, see [`docs/DEPLOY.md`](docs/DEPLOY.md).

```bash
export PATH="$HOME/.local/anchor-0.31.1/bin:$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$PATH"
npm run anchor:build      # target/deploy/greencat.so + test-only greencat-short.so
npm run anchor:build:mainnet   # --features mainnet (pins the $GC mint + Token-2022)
cargo test -p greencat
npm run derive-pdas
```

Mainnet Program ID (`--features mainnet`): `2pwrnxCswbq9cjgfRWQAMJUp6n1MRALpURLBjbmFURdc` (Devnet Program ID: `8Sy7mqZjHg9U9JW2qe1fEAfooyUrnDkz1XdqFB3ywvPE`). `pool_id`: 0=daily_rewards 1=long_rewards 2=wheel_bank 3=nft_fee_treasury 4=mint_proceeds 5=airdrop.
All amounts are **raw** (UI × 10^6). $GC can be Token-2022 or classic SPL (`token_interface`). Config LEN 312 and Collection LEN 2824, so **re-init fresh** after this upgrade.

### Local tests (spawn their own validator, offline: ORAO + Metaplex from `tests/fixtures/`)

```bash
npm run test:e2e --workspace=@greencat/api          # stake → SIWS → /bonus verify (API-03), indexer
npm run test:e2e:market --workspace=@greencat/api   # collection NFT, mint + instant VRF reveal, list/buy, offers, indexer
npm run test:security                               # 94 negative cases × (Token-2022, classic SPL)
npm run test:scripts --workspace=@greencat/api      # the CLI scripts below, against localnet
npm run test:vrf-expiry --workspace=@greencat/api   # /admin Set VRF expiry: admin sets 3600, non-admin + out-of-range refused (prod build)
```

### Init and admin scripts (`npx tsx`, env `RPC_URL`, `KEYPAIR_PATH`, `GC_MINT`, `TOKEN_PROGRAM=spl|token2022`)

| Command | What |
|---|---|
| `npm run init-treasuries` | `initialize_treasuries`. The signer **must be the program's upgrade authority**. |
| `npm run init-collection` | `initialize_collection` + `create_collection_nft` (+ `ROYALTY_BPS` / `ROYALTY_RECIPIENT` before the first mint). **Set `METADATA_BASE_URI=ipfs://bafybeihq3n4h2756mmonwi5ckia3vztc47zuzcglx5dqxmt6dfk2zmzap4/`** (art-v1 metadata v2). Without it, the script falls back to `https://www.greencat69420.com/nft/`, and the base can never be changed later. |
| `npm run mint-nft` | Mint one NFT (10,000 $GC) and auto-settle its reveal (`NO_SETTLE=1` to skip) |
| `npm run list-nft -- <mint> <price_ui>` / `npm run buy-nft -- <mint> <expected_price_ui>` | Marketplace (the buy fails if the price changed) |
| `npm run reveal -- status\|init-pool\|request\|settle\|crank` | Per-mint reveal queue: pool init, legacy/expired VRF requests, settle crank (anyone) |
| `npm run admin -- status\|propose\|accept\|pause\|unpause\|vrf-expiry\|royalty\|close-mint` | Admin. With `PRINT_ONLY=1 AUTHORITY=<squads vault>`, prints the ix for a Squads transaction. |
| `npm run airdrop -- snapshot\|create\|reclaim …` | Merkle airdrop: holder snapshot → tree + proofs JSON → on-chain root |
| `GC_MINT=… POOL_ID=… AMOUNT_UI=… npm run deposit-treasury` / `withdraw-treasury` | Pool funding (withdrawals respect the liability floors) |

### Features in short
- **Mint:** 10,000 $GC → `mint_proceeds`; 10,000 supply. **Instant per-mint reveal:** each mint requests its own ORAO VRF; seconds later `settle_mint` (anyone; strict mint order) draws a random id from the remaining pool (swap-and-pop, no repeats) and writes `GreenCat #id` / `{base}{id}.json`. Over the full 10k, rarity counts are exactly 100/900/2000/7000 (seed `greencat-meme-collection-v1`). The update authority is a program PDA, the collection is verified, and the royalty is 500 bps: by default to the fee-treasury PDA (Devnet), and on **mainnet to the owner's wallet `13zew…fyj6`** (`init-collection` enforces this).
- **Marketplace:** 1% fee → `nft_fee_treasury`. `buy_nft(expected_price)` and `accept_offer(min_amount)` give slippage protection.
- **Staking:** daily `0.0136986301%/24h` claim-only. 365-day tranches carry a promotional bonus from `long_rewards` (the owed bonus is a withdraw floor).
- **Airdrop:** off-chain snapshot → Merkle root (`create_airdrop`) → users `claim_airdrop` with a proof → `reclaim_airdrop` after expiry.
- **Admin:** two-step `propose_authority` / `accept_authority` (Squads-ready), `set_paused`, bounded setters.

## Notes

- No guaranteed-returns copy for 365d bonus.
- Mainnet Config authority, upgrade authority, and 5% royalty recipient are `13zewBMqmpvv9oJWaqBRn9ww59h6qBh7z5XNpowyfyj6`.
- Devnet authority `keys/devnet-authority.json` often has **0 SOL** (public faucet rate-limited).

## Build status

| Piece | Status (2026-10-25 PT) |
|-------|--------|
| `cargo test -p greencat`, clippy `-D warnings` (3 feature sets), `cargo audit` | pass (0 vulnerabilities) |
| SDK / API vitest, localnet e2e (stake/bonus, market spl + token2022), security 94 × 2, scripts smoke | pass |
| `npm run build` (apps/web) | pass |
| Devnet deploy / init (`8Sy7mqZjHg9U9JW2qe1fEAfooyUrnDkz1XdqFB3ywvPE`) | **Live** |
| Mainnet deploy / init (`2pwrnxCswbq9cjgfRWQAMJUp6n1MRALpURLBjbmFURdc`) | **Live (`https://app.greencat69420.com`)** |

Demo app at `/workspace/greencat-holder-app` is **not** modified by this repo.
