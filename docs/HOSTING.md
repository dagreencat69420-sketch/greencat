# Public hosting (API + indexer worker + web)

Nothing in this repo is deployed. These are the accounts, env vars, and rough costs you need to put
the global backend online. Pricing was checked 2026-09-30 PT, so confirm on each provider's page before you sign up.

## Shape

```
Vercel (apps/web, static Next.js) ──HTTPS──▶ API (apps/api dist/server.js) ──▶ Postgres (Neon / Supabase)
                                              │  RUN_INDEXER=true  (or a separate dist/worker.js)
                                              └──▶ Solana RPC (Helius free)  ◀── optional Helius webhook → POST /webhooks/helius
```

The API runs migrations automatically on start. One process is enough: `RUN_INDEXER=true` runs the
indexer inside the API, so you don't need a separate worker service at low volume.

## Options and rough cost

| Piece | Free option | Cheap, always-on option | Notes |
|---|---|---|---|
| Postgres | **Neon Free**: 0.5 GB, 100 CU-h/mo, scales to zero | Neon Launch (usage-based) | Supabase Free also works (500 MB; pauses after ~1 week idle). Render's free Postgres expires after 30 days, so don't use it. |
| API (+ indexer) | Render Free web service: sleeps after 15 min idle, and the in-process indexer stops while it sleeps | **Railway Hobby $5/mo** (includes $5 usage), Fly.io (~$2–5/mo for a shared-cpu-1x 256–512 MB machine), Render Starter $7/mo | An always-on box is needed if you want the poller to run continuously. |
| Separate worker (optional) | n/a: Render has no free workers | Railway (same $5 plan), Render worker $7/mo | Only needed if you split `dist/worker.js` out. |
| Web | **Vercel Hobby**: free, non-commercial use only | Vercel Pro $20/mo per member | Root Directory = `apps/web`. |
| RPC | **Helius Free**: 1M credits/mo, 10 RPS, webhooks included, no card | Helius Developer $49/mo (10M credits) | Public `api.mainnet-beta.solana.com` rate-limits too much for the indexer. |

**Realistic minimum:** about **$0–5/mo**. Neon Free + Vercel Hobby + Helius Free cost nothing, and you add
Railway Hobby ($5) for an always-on API with the indexer. A fully free setup (Render Free web) works for the Points API,
but the indexer pauses whenever the service sleeps. To work around that, use the Helius webhook for ingest: the push wakes the service, and the first request is slow.

**Helius credit budget:** each poll tick makes 1 `getSignaturesForAddress` call. Helius may bill that as archival
(10 credits), so budget on the high side. Each new tx adds 1 `getTransaction` call, and so does each `/bonus` claim.
At `POLL_MS=60000` an idle month is about 43k ticks, roughly 43k–430k credits, which fits the free tier.
The default `POLL_MS=5000` is about 520k ticks/mo, which can exceed the 1M free credits.
On Helius Free, either use `POLL_MS>=60000`, or use the webhook (1 credit per push) with a long safety poll
(`INDEXER_MODE=ws`, `INDEXER_SAFETY_POLL_MS=300000`, or a large `POLL_MS`).

## Accounts you'd need to create

1. **Neon** (or Supabase): create a project and copy the pooled connection string (`postgres://…?sslmode=require`).
2. **Helius**: free API key → `https://mainnet.helius-rpc.com/?api-key=KEY` (or `devnet.helius-rpc.com`).
3. **Railway** (or Fly / Render): deploy this repo (the monorepo root) as a Node service.
4. **Vercel**: import the repo with Root Directory `apps/web`.
5. *(optional)* a Helius webhook: type **raw**, account = program ID, URL `https://<api>/webhooks/helius`,
   auth header = your `HELIUS_WEBHOOK_SECRET`.

## API service settings

Build command (from the repo root): `npm ci && npm run build --workspace=@greencat/api`
Start command: `npm run api:start` (that is `node apps/api/dist/server.js`; migrations are read from `apps/api/migrations`)
Health check: `GET /health`

| Env var | Value |
|---|---|
| `NODE_ENV` | `production` (the API refuses to start without `JWT_SECRET`) |
| `PORT` | usually injected by the host |
| `DATABASE_URL` | Neon/Supabase `postgres://…?sslmode=require` |
| `JWT_SECRET` | `openssl rand -hex 32` (≥32 chars) |
| `RPC_URL` | Helius URL (mainnet or devnet, matching where the program is deployed) |
| `GREENCAT_PROGRAM_ID` | `8Sy7mqZjHg9U9JW2qe1fEAfooyUrnDkz1XdqFB3ywvPE` (or the deployed ID) |
| `CORS_ORIGINS` | `https://<your-app>.vercel.app` (comma-separated, plus a custom domain if you have one) |
| `SIWS_DOMAIN` | `<your-app>.vercel.app` (shown in the wallet sign-in popup) |
| `SIWS_URI` | `https://<api-host>` |
| `TRUST_PROXY` | Default `false`: `X-Forwarded-For` / `X-Real-IP` are ignored and every request shares one rate-limit bucket (`"local"`; the socket address is not used), so a single busy client can rate-limit everyone. Set `true` **only** when every request passes a proxy that overwrites those headers (Railway / Fly / Render / Vercel / Cloudflare do). Otherwise clients can spoof their IP and dodge the per-IP rate limit (API-01). |
| `RUN_INDEXER` | `true` (single-process) or `false` if you run `npm run start:worker --workspace=@greencat/api` separately |
| `INDEXER_MODE` / `POLL_MS` | `poll` / `60000` on Helius Free |
| `HELIUS_WEBHOOK_SECRET` | optional; enables `POST /webhooks/helius` |
| `BONUS_DAILY_CAPS` | Default `{"mint":10,"stake":3,"list":5}` (bonus awards per wallet per UTC day, API-03). `'{}'` disables the caps. Unknown kinds or negative values fail startup (a retired `wheel` key is ignored). |
| `BONUS_MIN_AMOUNTS` | Default `{"stake":1000,"list":100}`, in whole $GC. A smaller stake / list price gets 422 `amount_too_small` and no points. `'{}'` disables the minimums. |

## Web (Vercel) env vars

| Env var | Value |
|---|---|
| `NEXT_PUBLIC_API_URL` | `https://<api-host>`. Without it, the app falls back to browser-local Points and no indexer browse. |
| `NEXT_PUBLIC_SOLANA_NETWORK` | `mainnet-beta` or `devnet` |
| `NEXT_PUBLIC_RPC_URL` | Helius URL. The key is exposed to browsers, so use a separate key or restrict allowed domains in the Helius dashboard. |
| `NEXT_PUBLIC_GC_MINT` | `$GC` mint |

## Prerequisite that is not about hosting

Bonus verification and the indexer only see real data once the `greencat` program is **deployed** on the
cluster that `RPC_URL` points to. That deploy needs a funded authority, which was not done here.
The program deploy, init order (treasuries → collection → collection NFT → royalty → pool funding), ORAO VRF notes,
Squads handover and the **SOL budget (~8 SOL on the Devnet deployer; ≈7.36 SOL minimum for deploy + init, nearly all locked in program data)** are in [`DEPLOY.md`](DEPLOY.md). Until then, the Points
daily claim, streaks, lo-fi, and leaderboard all work, but `/bonus` and `/listings` will have nothing to verify or index.
