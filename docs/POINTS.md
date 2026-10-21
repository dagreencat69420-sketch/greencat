# Engagement Points

**Status:** web + SDK shipped 2026-09-26 PT (client-local). The global server-authoritative backend (`apps/api`) was added 2026-09-29 PT.
The web app uses the API when `NEXT_PUBLIC_API_URL` is set and otherwise falls back to `localStorage`.  
**Not** on-chain. Never spendable / never convertible to `$GC` / never affects stake, mint, or market balances.

## Rules (demo parity)

| Feature | Behavior |
|---------|----------|
| Daily claim | Random **1–100** once per **America/Vancouver** calendar day |
| Streaks | Consecutive daily claims; miss a Vancouver day → streak resets |
| Milestones | +10 / +25 / +100 at 3 / 7 / 30 days (**once per streak**) |
| Monthly reset | Points → 0 on 1st Vancouver; **streak kept** |
| Activity | mint +15 · stake open/add +10 · list +10 · (wheel spin +5: removed Oct 12, 2026) · lo-fi +1/~60s (cap **10**/day) |

## Storage

| Mode | When | Persistence |
|---|---|---|
| **API (global)** | `NEXT_PUBLIC_API_URL` set | `apps/api` Postgres/PGlite; `ApiPointsProvider` in `PointsContext.tsx` |
| **Local fallback** | env unset | `localStorage` key `greencat.points.v1` (`apps/web/src/lib/pointsStorage.ts`); the board covers this browser only |

The pure rules live in `packages/sdk/src/points.ts`. The browser fallback and the server use the same functions.

## API endpoints (`apps/api`)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/auth/nonce` `{wallet}` | – | SIWS message + single-use nonce (TTL 5 min) |
| POST | `/auth/verify` `{wallet,nonce,signature}` | – | ed25519 check (tweetnacl) → HS256 JWT (1 h) |
| GET | `/leaderboard?month=YYYY-MM` | – | `{month,total,top[10]}`. Everyone is ranked, but only the top 10 are returned. |
| GET | `/me` | Bearer | own points, streak, milestones, `rank` (even outside top 10), `claimedToday`, `nextReset` |
| POST | `/claim` | Bearer | daily 1–100 roll (server RNG), once per Vancouver day |
| POST | `/bonus` `{kind,signature}` | Bearer | activity bonus, verified on-chain |
| POST | `/lofi/heartbeat` | Bearer | +1 per ≥~60 s of server time, cap 10/day |
| GET | `/health` | – | DB + indexer cursor |

## Anti-cheat

- **Nothing client-supplied is trusted for amounts.** The client never sends point values. The server rolls the 1–100 amount with `crypto.randomInt`.
- **Day/month boundaries use the server clock** in America/Vancouver. One claim per day is enforced by a DB unique constraint, so concurrent claims yield exactly one success (covered by a test).
- **Streaks and milestones** (+10/+25/+100 at 3/7/30) are awarded once per streak. The monthly reset on the 1st zeroes points but keeps the streak, and each month's board is kept by month key.
- **Activity bonuses** require a tx signature, and the server fetches the tx from `RPC_URL`. The tx must have succeeded and be no older than `BONUS_MAX_TX_AGE_SEC`. A top-level instruction must target the GreenCat program, with the Anchor discriminator matching the kind
  (mint→`mint_nft`, stake→`stake_daily|add_daily|stake_long`, list→`list_nft`). Default daily caps and minimum amounts (API-03): see `docs/HOSTING.md`.
  Its first account must be the session wallet, which must also be a signer, and the program's own event/log must confirm the action.
  Each **signature is usable once** (409 on replay). Per-kind daily caps (`BONUS_DAILY_CAPS`) and minimum amounts (`BONUS_MIN_AMOUNTS`) are on by default.
- **Lo-fi:** the server enforces the interval between heartbeats and the 10/day cap, so client timers can't speed it up.
- **Rate limits** apply per IP (auth) and per wallet (claim/bonus/lofi). Set `TRUST_PROXY=true` only behind a proxy that overwrites `X-Forwarded-For` / `X-Real-IP`. The default `false` ignores those headers.
- **Sessions:** the SIWS nonce is single-use and expiring, and a bad signature, wrong wallet, or expired nonce is rejected. `JWT_SECRET` is mandatory in production.

Tests: `npm run api:test` (integration) and `npm run api:e2e` (real localnet txs → `/bonus`).

## Files

| Path | Role |
|------|------|
| `packages/sdk/src/points.ts` | Rules + `PointsStore` interface + leaderboard ranking |
| `apps/web/src/lib/pointsStorage.ts` | localStorage adapter |
| `apps/web/src/context/PointsContext.tsx` | React state, claim, bonuses, lo-fi ticks |
| `apps/web/src/app/points/page.tsx` | Points UX (lime/neon) |
| `apps/web/src/components/{AppNav,PointsToast,LofiPlayer,ConnectedRedirect}.tsx` | Nav, toast, lo-fi, first-connect redirect |

## Bonus wiring

| Action | Where awarded |
|--------|----------------|
| Mint NFT | `MintPanel` after confirmed mint |
| Stake daily / add daily / stake 365 | `StakePanel` (`awardStakeBonus`) |
| List NFT | `MarketplacePanel` after confirmed list |
| Lo-fi | `LofiPlayer` every ~60s while playing (cap 10/day) |

## Landing

- Nav: **Points** first; logo → `/points` when wallet connected.
- First connect this session from `/` → one-shot redirect to `/points` (`sessionStorage`).
- Home keeps full hub panels; connected users see a Points CTA banner.

## Hosting

See [`HOSTING.md`](HOSTING.md).
