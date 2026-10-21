# @greencat/indexer (legacy JSON stub)

> **Superseded by [`apps/api`](../api/README.md)**: its Postgres/PGlite-backed worker (`npm run indexer:poll`)
> and the `GET /listings` / `GET /nft/:mint` endpoints. This package is kept only for the dependency-free
> JSON dump + parser fixture. The shared, tested parser now lives in `packages/sdk/src/marketplaceLogs.ts`.

```bash
npm run indexer:legacy                  # old JSON poller
npm run indexer:fixture                 # parser fixture (no RPC)
```
