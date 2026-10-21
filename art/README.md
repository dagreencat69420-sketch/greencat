# GreenCat 10k art pipeline: art-v1, PHASE 1 (samples for approval)

Status (2026-09-30): you **approved** the phase 1 samples, and the **full 10k render is complete**. Results: `out/images/1..10000.png` took 46.5 min with 6 workers and uses 4.84 GB; 0 missing, empty or invalid files and 0 metadata mismatches (`reports/full-render-check.json`). The spot check is `out/spotcheck-sheet.png`. Art-v1 traits are ported to `packages/sdk/src/artCatalog.ts` and `apps/web`. WebP deliverables: `out/images-webp/{id}.webp` (q92, 1024x1024, 690,370,208 bytes = 0.690 GB; `tools/convert_webp.py`). **Nothing has been uploaded**; see `UPLOAD-PLAN.md` and `tools/upload_nftstorage.mjs` (`--dry-run` is free/offline).

## Rarity source of truth (parity with the demo, SDK and on-chain program)

| Tier | Count | Share | Colour |
|---|---:|---:|---|
| Legendary | 100 | 1% | #FBBF24 |
| Rare | 900 | 9% | #A78BFA |
| Uncommon | 2,000 | 20% | #38BDF8 |
| Common | 7,000 | 70% | #94A3B8 |

- The seed is `greencat-meme-collection-v1`. It is hashed with FNV-1a (`hashSeed` = 3574348136) and fed to mulberry32, which drives a Fisher–Yates shuffle over `[100 L, 900 R, 2000 U, 7000 C]`. `token_id` (1-indexed) maps to `table[id-1]`.
- The same logic exists in `greencat-holder-app/src/lib/nftCatalog.ts` (demo), `packages/sdk/src/nftCatalog.ts`, `programs/greencat/src/rarity.rs` and `scripts/generate-metadata.mjs`. `art/catalog.py` is a byte-exact Python port of it.
- Run `python greencat_art.py verify` to check parity. It compares all 10,000 tokens against a read-only dump of the demo and SDK, made by importing the TS files with `tsx` in `tools/dump_reference.mts`. It also checks the `rarity.rs` test vectors. Current result: **0 mismatches**, exact tier counts, 10,000 unique visual combos.
- The demo `Catchphrase` comes from an exact port of demo `getTokenTraits`, verified on all 10k tokens.

## Why there are new visual traits (art-v1)
The demo's `getTokenTraits` picks uniformly with no link to rarity, and it has no art. The art-v1 traits are rarity-weighted pools. They draw from their own RNG namespace (`{seed}:art-v1:{id}`), so they **cannot change rarity**. **Follow-up:** the holder app and SDK still display the old demo trait text. Port `out/catalog-art-v1.json` (or `catalog.py` → TS) into the SDK and app before mint so the UI matches the art. I left the demo untouched as instructed.

## Duplicate handling
Tokens are processed in ascending id. If a token's 7-layer visual combo already exists, it is re-rolled with salt `:reroll:k` until the combo is unique. About 1.26k of the 10k tokens are re-rolled, mostly commons. This is deterministic, and the result is 0 duplicates.

Two more deterministic rules:
- Opaque eyewear (Cool Shades, Pixel Shades, Neon Visor, Gold Aviators) is dropped if it would hide a special expression. Laser Eyes are allowed because the beams fire through the lenses.
- Low-contrast fur/background pairs (e.g. Holographic on Holo Foil, Gold on Golden Vault) swap to a fixed alternative background.

Because of these rules, the odds below are **draw weights**. The real counts per value are in `reports/distribution.md`.

## Trait layers and draw odds per tier (draw order matches the compositing order)

### Background

| Value | Common | Uncommon | Rare | Legendary |
|---|---:|---:|---:|---:|
| Concrete Grey | 9.2% | 3.0% | - | - |
| Mint Flat | 9.2% | 3.0% | - | - |
| Cream Flat | 8.2% | 3.0% | - | - |
| Sky Flat | 8.2% | 3.0% | - | - |
| Peach Flat | 8.2% | 3.0% | - | - |
| Lavender Flat | 8.2% | 3.0% | - | - |
| Sage Flat | 8.2% | 3.0% | - | - |
| Butter Flat | 8.2% | 3.0% | - | - |
| Coral Flat | 7.1% | 3.0% | - | - |
| Seafoam Flat | 7.1% | 3.0% | - | - |
| Slate Flat | 6.1% | 3.0% | - | - |
| Deep Forest | 4.1% | 14.0% | 6.4% | - |
| Vinyl Void | 3.1% | 13.0% | 6.4% | - |
| Halftone Lime | 3.1% | 12.0% | 6.4% | - |
| Pixel Meadow | 2.0% | 12.0% | 6.4% | - |
| Neon Alley | - | 5.0% | 16.0% | 5.6% |
| Sol Dusk | - | 4.0% | 16.0% | 6.7% |
| Lime Nebula | - | 4.0% | 14.9% | 6.7% |
| Chart Green | - | 3.0% | 14.9% | 6.7% |
| Lo-fi Night | - | - | 12.8% | 13.3% |
| Laser Loft | - | - | - | 15.6% |
| Holo Foil | - | - | - | 15.6% |
| Golden Vault | - | - | - | 15.6% |
| Moonlit Rooftop | - | - | - | 14.4% |

### Fur

| Value | Common | Uncommon | Rare | Legendary |
|---|---:|---:|---:|---:|
| Lime Vinyl | 44.0% | 27.1% | 12.0% | 4.5% |
| Mint Vinyl | 9.0% | 10.4% | 5.0% | - |
| Forest Vinyl | 9.0% | 10.4% | 5.0% | - |
| Chartreuse | 8.0% | 10.4% | 5.0% | - |
| Olive Glow | 8.0% | 9.4% | 5.0% | - |
| Neon Cream | 8.0% | 9.4% | 5.0% | - |
| Sky Vinyl | 7.0% | 8.3% | 6.0% | - |
| Bubblegum | 7.0% | 8.3% | 6.0% | - |
| Midnight | - | 6.2% | 8.0% | 4.5% |
| Sol Gradient | - | - | 12.0% | 9.1% |
| Chrome | - | - | 12.0% | 15.9% |
| Gold | - | - | 11.0% | 18.2% |
| Holographic | - | - | 4.0% | 20.5% |
| Glow-in-the-Dark | - | - | 4.0% | 13.6% |
| Galaxy | - | - | - | 13.6% |

### Eyes

| Value | Common | Uncommon | Rare | Legendary |
|---|---:|---:|---:|---:|
| Grumpy | 36.0% | 27.1% | 18.0% | 10.0% |
| Side-Eye | 15.0% | 14.6% | 10.0% | 5.0% |
| Tiny Pupils | 12.0% | 10.4% | 8.0% | - |
| Big Pupils | 12.0% | 10.4% | 8.0% | - |
| Sleepy | 13.0% | 10.4% | 8.0% | - |
| Wink | 12.0% | 10.4% | 8.0% | 7.5% |
| Heart Eyes | - | 8.3% | 10.0% | 10.0% |
| Dizzy | - | 8.3% | 10.0% | 5.0% |
| Star Eyes | - | - | 8.0% | 12.5% |
| Glow Eyes | - | - | 7.0% | 15.0% |
| Laser Eyes | - | - | 5.0% | 35.0% |

### Eyewear

| Value | Common | Uncommon | Rare | Legendary |
|---|---:|---:|---:|---:|
| None | 66.0% | 57.7% | 45.0% | 40.2% |
| Round Specs | 10.0% | 9.3% | 6.0% | - |
| Cool Shades | 10.0% | 10.3% | 10.0% | 6.9% |
| 3D Glasses | 7.0% | 8.2% | 8.0% | - |
| Monocle | 7.0% | 7.2% | 8.0% | 6.9% |
| Pixel Shades | - | 7.2% | 10.0% | 9.2% |
| Neon Visor | - | - | 10.0% | 13.8% |
| Gold Aviators | - | - | 3.0% | 23.0% |

### Hat

| Value | Common | Uncommon | Rare | Legendary |
|---|---:|---:|---:|---:|
| None | 34.0% | 25.5% | 14.7% | - |
| Beanie | 10.0% | 9.6% | 6.3% | - |
| Backwards Cap | 10.0% | 9.6% | 6.3% | - |
| Bandana | 9.0% | 8.5% | 5.3% | - |
| Bucket Hat | 9.0% | 8.5% | 5.3% | - |
| Headphones | 9.0% | 10.6% | 10.5% | 11.1% |
| Party Hat | 8.0% | 6.4% | 5.3% | - |
| Propeller Cap | 6.0% | 7.4% | 7.4% | - |
| Cowboy Hat | 5.0% | 6.4% | 7.4% | 8.3% |
| Wizard Hat | - | 4.3% | 8.4% | 13.9% |
| Top Hat | - | 3.2% | 8.4% | 13.9% |
| Crown | - | - | 8.4% | 30.6% |
| Halo | - | - | 6.3% | 22.2% |

### Accessory

| Value | Common | Uncommon | Rare | Legendary |
|---|---:|---:|---:|---:|
| None | 35.1% | 25.0% | 12.0% | - |
| Bow Tie | 10.3% | 9.4% | 6.0% | - |
| Scarf | 10.3% | 9.4% | 6.0% | - |
| Silver Chain | 10.3% | 10.4% | 8.0% | - |
| Coffee Cup | 10.3% | 9.4% | 6.0% | - |
| Balloon | 9.3% | 8.3% | 6.0% | - |
| Cassette Tape | 9.3% | 8.3% | 7.0% | 5.0% |
| Gold Chain | 5.2% | 9.4% | 10.0% | 10.0% |
| $GC Pendant | - | 6.2% | 10.0% | 12.5% |
| Vinyl Record | - | 2.1% | 6.0% | 10.0% |
| Sol-Gradient Coin | - | 2.1% | 9.0% | 12.5% |
| $GC Neon Sign | - | - | 9.0% | 22.5% |
| Diamond Chain | - | - | 5.0% | 27.5% |

### Aura

| Value | Common | Uncommon | Rare | Legendary |
|---|---:|---:|---:|---:|
| None | 100.0% | 100.0% | 70.0% | - |
| Sparkles | - | - | 15.0% | 28.0% |
| Lime Glow | - | - | 15.0% | 26.0% |
| Gold Aura | - | - | - | 24.0% |
| Neon Aura | - | - | - | 22.0% |
## Files
- `source/character-reference-sheet.jpg`: the user's reference sheet (1792x1008).
- `tools/extract_base.py` builds `base/greencat-base-front.png`, a transparent 567x860 front view cut from the sheet. It uses a colour-key matte with background-difference rim recovery, hole fill, edge decontamination, Lanczos upscale and unsharp. No AI and no Runway.
- `catalog.py`: rarity port, demo-trait port, art-v1 pools, collision handling and metadata JSON.
- `render.py`: compositor. Everything is drawn in code (Pillow/numpy), supersampled at 2048 and downsampled to 1024.
- `greencat_art.py`: CLI (`verify | metadata | samples | render | bench`).
- `layers/<Layer>/<value>.png`: each trait exported as a standalone 1024 transparent PNG for designers. `layers/preview-<Layer>.png` are review sheets.
- `samples/`: 16 sample PNGs with their JSON (4 per tier, including parity ids 1/42/100/5000) and `contact-sheet.png`.
- `out/metadata/{1..10000}.json`: full Metaplex-style metadata (name `GreenCat #N`, symbol GCAT, Rarity + traits + Catchphrase + Catalog Seed + Token ID). The image URI is `{base}{id}.webp` with base placeholder `ipfs://__IMAGES_CID__/` (`metadata --base <uri>` or env `IMAGE_BASE_URI` to change; `metadata --base X --out DIR` writes a staging copy). `properties.files[0].type` is `image/webp`.
- `out/catalog-art-v1.json`: compact token → rarity/traits table for porting to the SDK and app.
- `reports/distribution.md` / `.json`: counts per trait across all 10k, computed from the metadata only.

## Commands
```bash
cd /workspace/greencat-app/art
.venv/bin/python greencat_art.py verify
.venv/bin/python greencat_art.py metadata            # --base https://.../nft/
.venv/bin/python greencat_art.py samples
.venv/bin/python greencat_art.py bench --n 48 --workers 6
# PHASE 2 (only after art approval):
.venv/bin/python greencat_art.py render --all --workers 6 --yes-full-render   # resumable: skips existing PNGs
```
The venv uses system Pillow 12.3 and numpy 2.2, with scipy and opencv-headless installed inside `art/.venv`.

## Full-render estimate (measured on this box: 8 vCPU, about 3 GB RAM free, no GPU)
- Benchmark: 48 tokens with 6 workers took 17.3 s, so **0.36 s per token wall time**, or about **60 min for all 10k** (allow 60–75 min). One worker takes about 1.4 s per token, roughly 4 h.
- Disk: about 0.49 MB per PNG, so **about 4.9 GB** for 10k images. Metadata is about 40 MB on disk because of small-file overhead. About 35 GB is free.

## Known quality caveats
- Hats, eyewear and accessories are vector-drawn with a fake vinyl bevel. They read as stickers on a 3D toy. A painted or 3D pass at the same registration (`layers/`) would improve this.
- Every token uses the same front pose, taken from the reference sheet, so it is always on-model. The source cut is about 363x551 px upscaled 2.4x, so the fur is slightly soft at 1024.
- Repainted expressions (lids, pupils) are flat compared with the original "Grumpy" eyes. Wink and Sleepy lids look like patches up close.
- "Animated" legendaries are static PNGs. Animated variants (`animation_url` MP4/GIF) are a possible phase 2 addition.
- The Solana theme uses only the Solana gradient colours. There are no Solana logos and no real brands. `$GC` is the project's own ticker.

## Next steps (not done)
1. User approves the art, trait list and odds.
2. Port art-v1 traits into the SDK and holder app so the UI trait text matches the art.
3. Run the full render.
4. Upload images, then set the `image` base and regenerate metadata.
5. Pin to IPFS and/or Arweave. This costs money and needs approval; see `docs/METADATA-PIPELINE.md`.
6. Run `initialize_collection` with the final base.
