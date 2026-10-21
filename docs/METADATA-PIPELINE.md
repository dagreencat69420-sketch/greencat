# NFT metadata / art pipeline

Status: **art-v1 approved and fully rendered (2026-09-30)**. All 10,000 PNG masters are in `art/out/images/`, the WebP deliverables (q92, 0.690 GB) are in `art/out/images-webp/`, and the metadata is in `art/out/metadata/` (image base placeholder `ipfs://__IMAGES_CID__/`, swapped in by `art/tools/upload_nftstorage.mjs`); see `art/README.md` and `art/UPLOAD-PLAN.md`. Off-chain JSON and images are **not** uploaded yet. On-chain mint already sets the Metaplex URI to `{metadata_base_uri}{token_id}.json`.

> The production source of truth is now `art/` (`catalog.py`, mirrored in the SDK as `packages/sdk/src/artCatalog.ts`). `scripts/generate-metadata.mjs` below is the old EXAMPLE stub, kept for reference only.

## Goals

- 10,000 deterministic catalog entries matching seed `greencat-meme-collection-v1` (demo + on-chain rarity bag).
- Metaplex Token Metadata URI resolves to JSON wallets / marketplaces can fetch.
- Rarity + traits in JSON attributes match demo `nftCatalog.ts` / SDK `packages/sdk/src/nftCatalog.ts`.

## URI schema

| Piece | Value |
|-------|--------|
| Collection PDA field | `metadata_base_uri` (max 128 bytes) |
| Default base | `https://www.greencat69420.com/nft/` |
| Per-token URI | `{base}{token_id}.json` — e.g. `…/nft/1.json` … `…/nft/10000.json` |
| Mint ix | Program builds `format!("{}{}.json", base, token_id)` at mint time (`programs/greencat/src/lib.rs`) |
| Name / symbol | `GreenCat #{id}` / `GCAT` |

**Important:** Change `metadata_base_uri` only via `initialize_collection` (or a future admin update ix). If you move hosting (CDN → Arweave gateway), re-init or add an update path **before** significant mint volume, or minted URIs will 404.

Token ids are **1-indexed** (1…10000), same as demo `gc-cat-00001`.

## Image naming

Art-v1 layout (two IPFS directories, see `art/UPLOAD-PLAN.md`):

```
ipfs://<IMAGES_CID>/
  1.webp … 10000.webp          # final art: WebP q92, 1024x1024 (PNG masters kept in art/out/images/)
ipfs://<METADATA_CID>/         # = metadata_base_uri for initialize_collection
  1.json … 10000.json          # image = ipfs://<IMAGES_CID>/{id}.webp, files[0].type = image/webp
  # OPTIONAL procedural fallbacks (demo parity):
  placeholders/
    EXAMPLE-common.svg
    EXAMPLE-rare.svg
    …
```

Internal slug (demo): `gc-cat-{tokenId padded 5}` → `gc-cat-00001`. Use for filenames if you prefer zero-padded names, but **Metaplex URI must still be `{id}.json`** unless you change the mint program.

Placeholder images in-repo must stay clearly marked `EXAMPLE` until real art lands.

## JSON schema (Metaplex-compatible)

```json
{
  "name": "GreenCat #1",
  "symbol": "GCAT",
  "description": "…",
  "image": "ipfs://<IMAGES_CID>/1.webp",
  "external_url": "https://www.greencat69420.com",
  "attributes": [
    { "trait_type": "Rarity", "value": "Common" },
    { "trait_type": "Background", "value": "…" },
    { "trait_type": "Fur", "value": "…" },
    { "trait_type": "Eyes", "value": "…" },
    { "trait_type": "Hat", "value": "…" },
    { "trait_type": "Accessory", "value": "…" },
    { "trait_type": "Catchphrase", "value": "…" },
    { "trait_type": "Catalog Seed", "value": "greencat-meme-collection-v1" },
    { "trait_type": "Token ID", "value": "1" }
  ],
  "properties": {
    "category": "image",
    "files": [{ "uri": "ipfs://<IMAGES_CID>/1.webp", "type": "image/webp" }]
  }
}
```

Rarity bag (fixed): Legendary 100 / Rare 900 / Uncommon 2000 / Common 7000. Trait pools match holder-app demo (`Background`, `Fur`, `Eyes`, `Hat`, `Accessory`, `Catchphrase`).

Sample checked into repo: [`metadata/examples/1.json`](../metadata/examples/1.json) (EXAMPLE image URI).

## How mint sets URI (already shipped)

1. `initialize_collection(metadata_base_uri)` stores base (or default).
2. `mint_nft` picks unminted `token_id`, reads rarity from packed bits, creates Metaplex metadata with URI `{base}{token_id}.json`.
3. Wallets fetch that URI **off-chain**. If JSON/image 404, NFT still exists on-chain with a broken preview.

There is **no** on-chain upload step. Ops must host JSON + images **before** mainnet mint opens (or accept broken previews until CDN is live).

## Generation stub

```bash
# From greencat-app root — writes EXAMPLE JSON under metadata/out/ (gitignored pattern OK)
node scripts/generate-metadata.mjs --limit 3
# Full catalog later:
node scripts/generate-metadata.mjs --limit 10000 --out metadata/out
```

Stub fills rarity via the same seed as the SDK. Trait text is EXAMPLE until you port full trait RNG from holder-app `getTokenTraits` into the SDK.

## Hosting options

| Option | Pros | Cons | Env / notes |
|--------|------|------|-------------|
| **HTTPS CDN** (default base on greencat69420.com) | Simple, cacheable, editable | Mutable; ops must not break URLs | `METADATA_BASE_URI=https://www.greencat69420.com/nft/` |
| **IPFS** | Content-addressed | Gateways vary; pin set required | Upload via NFT.Storage / Pinata / web3.storage; set base to `https://<gateway>/ipfs/<CID>/` with files named `1.json`… |
| **Arweave** | Permanent | Upload cost; harder to fix typos | Bundlr/Irys upload; base = `https://arweave.net/<tx>/` or per-file TX ids (then URI scheme may need per-token URIs — prefer directory manifest) |

**Recommendation for v1:** pin full tree to IPFS **and** mirror on `greencat69420.com/nft/` with identical paths. Point `metadata_base_uri` at the HTTPS mirror for wallet reliability; keep IPFS CID in docs for provenance.

Env vars (docs / future upload script):

```bash
METADATA_BASE_URI=https://www.greencat69420.com/nft/
# Optional upload tooling (not required for local stub):
NFT_STORAGE_TOKEN=          # or PINATA_JWT=
ARWEAVE_WALLET_PATH=        # Irys/Bundlr key — never commit
IPFS_GATEWAY=https://nftstorage.link/ipfs/
```

## Checklist before mainnet mint

- [ ] Final art approved (not EXAMPLE placeholders)
- [ ] Generate 10k JSON + images; verify token `#1` rarity matches SDK `getTokenRarity(1)`
- [ ] Upload + pin; spot-check `1.json`, `42.json`, `10000.json` in browser + Phantom
- [ ] `initialize_collection` with final `METADATA_BASE_URI`
- [ ] Freeze or document mutation policy for CDN

## Related

- SDK: `packages/sdk/src/nftCatalog.ts` (`CATALOG_SEED`, `metadataUriForToken`)
- Demo traits reference: `/workspace/greencat-holder-app/src/lib/nftCatalog.ts` (do not modify unless copying helpers)
- Web UI note: Mint panel links here while metadata is unpublished
