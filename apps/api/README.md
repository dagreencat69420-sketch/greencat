# @greencat/api — global backend

Server-authoritative **Points** (global leaderboard) + **marketplace indexer** + browse API.
Hono on Node 20, Postgres (or embedded PGlite for local dev/tests), plain SQL migrations.

```
apps/api
  migrations/001_init.sql     schema (points + marketplace)
  src/server.ts               HTTP API (optionally runs the indexer in-process: RUN_INDEXER=true)
  src/worker.ts               standalone indexer worker (poll | ws)
  src/app.ts                  routes
  src/auth.ts                 Sign-In-With-Solana (nonce → ed25519 verify → JWT)
  src/points/service.ts       claim / bonus / lo-fi / leaderboard (rules from @greencat/sdk)
  src/verify/activityTx.ts    on-chain proof for activity bonuses
  src/indexer/*               log parser → DB, cursor, NftRecord backfill, listing queries
  test/api.test.ts            integration tests (PGlite in-memory, or real Postgres via TEST_DATABASE_URL)
  test/e2e-localnet.ts        solana-test-validator: stake → /bonus verify + replay reject + indexer
  test/e2e-market-localnet.ts validator + Metaplex clone: mint/list/buy/offer → indexer + /bonus mint/list
```

## Run

```bash
cp apps/api/.env.example apps/api/.env      # optional; defaults work for local dev
npm run api:dev                             # http://localhost:8787 (PGlite at apps/api/data/pglite)
npm run indexer:poll                        # separate worker (or RUN_INDEXER=true in the API)
npm run api:test                            # integration tests
npm run api:e2e                             # localnet e2e (spawns its own validator on :18899)
npm run test:e2e:market --workspace=@greencat/api   # marketplace e2e (clones Metaplex from mainnet, read-only)
```

Production: `npm run build --workspace=@greencat/api` → `node apps/api/dist/server.js` (and `dist/worker.js`).

### Database choice

| `DATABASE_URL` | Driver | Use |
|---|---|---|
| `postgres://…` | `pg` (node-postgres pool) | Docker Postgres, Neon, Supabase, Railway… |
| unset / `pglite:./data/pglite` | **PGlite** (Postgres compiled to WASM, embedded) | local dev without Docker |
| `pglite:memory` | PGlite in-memory | tests |

The brief suggested SQLite as the no-Docker fallback. I used **PGlite** because it is real Postgres: one
migration set, the same window functions / `ON CONFLICT` / partial unique indexes / JSONB, and no
native build step. SQLite would have needed a second SQL dialect. The integration suite passes on
both PGlite and a real Postgres 17 server (`TEST_DATABASE_URL=postgres://… npm run api:test`).
Docker was not available on the build box. `apps/api/docker-compose.yml` is there if you want a local Postgres.

See `docs/POINTS.md` (anti-cheat, endpoints) and `docs/INDEXER.md` (indexer modes, RPC, hosting).

## Public hosting (summary)

Full guide: [`docs/HOSTING.md`](../../docs/HOSTING.md).
- **Postgres:** Neon Free or Supabase Free → `DATABASE_URL`
- **API + indexer:** Railway Hobby ($5/mo, always on) or Fly.io / Render Starter ($7). Render Free works, but it sleeps, and the in-process indexer pauses while it sleeps.
  Build `npm ci && npm run build --workspace=@greencat/api`, start `npm run api:start`, with `RUN_INDEXER=true`.
- **Web:** Vercel Hobby (free, non-commercial), Root Directory `apps/web`, `NEXT_PUBLIC_API_URL=https://<api>`
- **RPC:** Helius Free (1M credits/mo). Set `POLL_MS>=60000` or use the `/webhooks/helius` raw webhook.
- **Required API env:** `NODE_ENV=production`, `DATABASE_URL`, `JWT_SECRET` (≥32 chars), `RPC_URL`, `GREENCAT_PROGRAM_ID`,
  `CORS_ORIGINS`, `SIWS_DOMAIN`, `SIWS_DOMAINS` (extra web hosts), `SIWS_URI`, `TRUST_PROXY=true`, `RUN_INDEXER`.
