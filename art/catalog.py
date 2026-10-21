"""GreenCat catalog core (rarity + art-v1 trait assignment). Pure Python, no image deps.

Rarity is a byte-exact port of the shared seed used by:
  - greencat-holder-app/src/lib/nftCatalog.ts   (demo, getRarityTable / getTokenTraits)
  - greencat-app/packages/sdk/src/nftCatalog.ts (SDK)
  - greencat-app/programs/greencat/src/rarity.rs (on-chain rarity bag)
  - greencat-app/scripts/generate-metadata.mjs
Seed "greencat-meme-collection-v1": FNV-1a(seed) -> mulberry32 -> Fisher-Yates over
[100 legendary, 900 rare, 2000 uncommon, 7000 common]; token_id (1-indexed) -> table[id-1].

Visual traits ("art-v1") are NEW, rarity-weighted pools (the demo's getTokenTraits pools are uniform
and have no art). They use a separate RNG namespace so they can never disturb rarity. The demo
Catchphrase (non-visual) is reproduced exactly via a port of getTokenTraits.
"""
from __future__ import annotations
import json

CATALOG_SEED = "greencat-meme-collection-v1"
ART_VERSION = "art-v1"
COLLECTION_SIZE = 10_000
RARITY_ORDER = ["legendary", "rare", "uncommon", "common"]          # insertion order in TS (Object.keys)
RARITY_COUNTS = {"legendary": 100, "rare": 900, "uncommon": 2000, "common": 7000}
RARITY_LABELS = {"legendary": "Legendary", "rare": "Rare", "uncommon": "Uncommon", "common": "Common"}
RARITY_COLORS = {"legendary": "#FBBF24", "rare": "#A78BFA", "uncommon": "#38BDF8", "common": "#94A3B8"}
TIER_INDEX = {"common": 0, "uncommon": 1, "rare": 2, "legendary": 3}
M32 = 0xFFFFFFFF


def _imul(a: int, b: int) -> int:
    return ((a & M32) * (b & M32)) & M32


def hash_seed(s: str) -> int:
    # JS iterates UTF-16 code units; all seeds here are ASCII
    h = 2166136261
    for ch in s:
        h ^= ord(ch)
        h = _imul(h, 16777619)
    return h & M32


def mulberry32(seed: int):
    a = seed & M32

    def rng() -> float:
        nonlocal a
        a = (a + 0x6D2B79F5) & M32
        t = _imul(a ^ (a >> 15), 1 | a)
        t = ((t + _imul(t ^ (t >> 7), 61 | t)) & M32) ^ t
        return ((t ^ (t >> 14)) & M32) / 4294967296.0

    return rng


_RARITY_TABLE = None


def rarity_table() -> list[str]:
    global _RARITY_TABLE
    if _RARITY_TABLE is None:
        table = [r for r in RARITY_ORDER for _ in range(RARITY_COUNTS[r])]
        rng = mulberry32(hash_seed(CATALOG_SEED))
        for i in range(len(table) - 1, 0, -1):
            j = int(rng() * (i + 1))
            table[i], table[j] = table[j], table[i]
        _RARITY_TABLE = table
    return _RARITY_TABLE


def token_rarity(token_id: int) -> str:
    if not 1 <= token_id <= COLLECTION_SIZE:
        raise ValueError(f"tokenId out of range: {token_id}")
    return rarity_table()[token_id - 1]


# ---- exact port of demo getTokenTraits (only to reproduce Catchphrase + legacy demo fields) ----
_D_BACKGROUNDS = ["deep forest", "neon alley", "vinyl void", "solana dusk", "laser loft", "cardboard castle",
                  "lime nebula", "pixel meadow", "moonlit litter", "chart green"]
_D_HATS = ["none", "beanie", "cowboy", "crown", "propeller", "wizard", "bandana", "headphones", "top hat", "halo"]
_D_EYES = ["sleepy", "wide", "wink", "laser", "heart", "dizzy", "cool shades", "side-eye"]
_D_ACC = ["none", "gold chain", "scarf", "backpack", "skateboard", "coffee", "balloon", "yo-yo", "laptop", "laser pointer"]
_D_CATCH = ["ngmi? ngmi not", "to the litterbox", "wagmi paws", "meow or never", "pump the yarn", "hodl whiskers",
            "based feline", "send it, human", "vibes only", "green candle cat", "purrcentage gains", "floor is lava"]
_D_FUR = ["lime vinyl", "forest", "mint", "chartreuse", "olive glow", "neon cream"]


def _pick(rng, arr):
    return arr[int(rng() * len(arr)) % len(arr)]


def demo_traits(token_id: int) -> dict:
    rarity = token_rarity(token_id)
    rng = mulberry32(hash_seed(f"{CATALOG_SEED}:traits:{token_id}"))
    hat = _pick(rng, _D_HATS)
    acc = _pick(rng, _D_ACC)
    if rarity == "common":
        if rng() < 0.55:
            hat = "none"
        if rng() < 0.6:
            acc = "none"
    elif rarity == "legendary":
        if hat == "none":
            hat = _pick(rng, [h for h in _D_HATS if h != "none"])
        if acc == "none":
            acc = _pick(rng, [a for a in _D_ACC if a != "none"])
    return {"background": _pick(rng, _D_BACKGROUNDS), "fur": _pick(rng, _D_FUR), "eyes": _pick(rng, _D_EYES),
            "hat": hat, "accessory": acc, "catchphrase": _pick(rng, _D_CATCH)}


# ---- art-v1 trait pools: value -> weights per tier (common, uncommon, rare, legendary) ----
# Weights are relative within each tier (normalised at runtime). 0 = never in that tier.
LAYERS: dict[str, dict[str, tuple[int, int, int, int]]] = {
    "Background": {
        "Concrete Grey": (9, 3, 0, 0), "Mint Flat": (9, 3, 0, 0), "Cream Flat": (8, 3, 0, 0),
        "Sky Flat": (8, 3, 0, 0), "Peach Flat": (8, 3, 0, 0), "Lavender Flat": (8, 3, 0, 0),
        "Sage Flat": (8, 3, 0, 0), "Butter Flat": (8, 3, 0, 0), "Coral Flat": (7, 3, 0, 0),
        "Seafoam Flat": (7, 3, 0, 0), "Slate Flat": (6, 3, 0, 0),
        "Deep Forest": (4, 14, 6, 0), "Vinyl Void": (3, 13, 6, 0), "Halftone Lime": (3, 12, 6, 0),
        "Pixel Meadow": (2, 12, 6, 0),
        "Neon Alley": (0, 5, 15, 5), "Sol Dusk": (0, 4, 15, 6), "Lime Nebula": (0, 4, 14, 6),
        "Chart Green": (0, 3, 14, 6), "Lo-fi Night": (0, 0, 12, 12),
        "Laser Loft": (0, 0, 0, 14), "Holo Foil": (0, 0, 0, 14), "Golden Vault": (0, 0, 0, 14),
        "Moonlit Rooftop": (0, 0, 0, 13),
    },
    "Fur": {
        "Lime Vinyl": (44, 26, 12, 4), "Mint Vinyl": (9, 10, 5, 0), "Forest Vinyl": (9, 10, 5, 0),
        "Chartreuse": (8, 10, 5, 0), "Olive Glow": (8, 9, 5, 0), "Neon Cream": (8, 9, 5, 0),
        "Sky Vinyl": (7, 8, 6, 0), "Bubblegum": (7, 8, 6, 0), "Midnight": (0, 6, 8, 4),
        "Sol Gradient": (0, 0, 12, 8), "Chrome": (0, 0, 12, 14), "Gold": (0, 0, 11, 16),
        "Holographic": (0, 0, 4, 18), "Glow-in-the-Dark": (0, 0, 4, 12), "Galaxy": (0, 0, 0, 12),
    },
    "Eyes": {
        "Grumpy": (36, 26, 18, 8), "Side-Eye": (15, 14, 10, 4), "Tiny Pupils": (12, 10, 8, 0),
        "Big Pupils": (12, 10, 8, 0), "Sleepy": (13, 10, 8, 0), "Wink": (12, 10, 8, 6),
        "Heart Eyes": (0, 8, 10, 8), "Dizzy": (0, 8, 10, 4), "Star Eyes": (0, 0, 8, 10),
        "Glow Eyes": (0, 0, 7, 12), "Laser Eyes": (0, 0, 5, 28),
    },
    "Eyewear": {
        "None": (66, 56, 45, 35), "Round Specs": (10, 9, 6, 0), "Cool Shades": (10, 10, 10, 6),
        "3D Glasses": (7, 8, 8, 0), "Monocle": (7, 7, 8, 6), "Pixel Shades": (0, 7, 10, 8),
        "Neon Visor": (0, 0, 10, 12), "Gold Aviators": (0, 0, 3, 20),
    },
    "Hat": {
        "None": (34, 24, 14, 0), "Beanie": (10, 9, 6, 0), "Backwards Cap": (10, 9, 6, 0),
        "Bandana": (9, 8, 5, 0), "Bucket Hat": (9, 8, 5, 0), "Headphones": (9, 10, 10, 8),
        "Party Hat": (8, 6, 5, 0), "Propeller Cap": (6, 7, 7, 0), "Cowboy Hat": (5, 6, 7, 6),
        "Wizard Hat": (0, 4, 8, 10), "Top Hat": (0, 3, 8, 10), "Crown": (0, 0, 8, 22), "Halo": (0, 0, 6, 16),
    },
    "Accessory": {
        "None": (34, 24, 12, 0), "Bow Tie": (10, 9, 6, 0), "Scarf": (10, 9, 6, 0), "Silver Chain": (10, 10, 8, 0),
        "Coffee Cup": (10, 9, 6, 0), "Balloon": (9, 8, 6, 0), "Cassette Tape": (9, 8, 7, 4),
        "Gold Chain": (5, 9, 10, 8), "$GC Pendant": (0, 6, 10, 10), "Vinyl Record": (0, 2, 6, 8),
        "Sol-Gradient Coin": (0, 2, 9, 10), "$GC Neon Sign": (0, 0, 9, 18), "Diamond Chain": (0, 0, 5, 22),
    },
    "Aura": {
        "None": (100, 100, 70, 0), "Sparkles": (0, 0, 15, 28), "Lime Glow": (0, 0, 15, 26),
        "Gold Aura": (0, 0, 0, 24), "Neon Aura": (0, 0, 0, 22),
    },
}
VISUAL_LAYERS = ["Background", "Fur", "Eyes", "Eyewear", "Hat", "Accessory", "Aura"]
OPAQUE_EYEWEAR = {"Cool Shades", "Pixel Shades", "Neon Visor", "Gold Aviators"}
EYES_OK_UNDER_OPAQUE = {"Grumpy", "Laser Eyes"}   # laser beams shoot through shades
MAX_REROLLS = 64
CLASH_PAIRS = {("Holographic", "Holo Foil"): "Moonlit Rooftop", ("Gold", "Golden Vault"): "Laser Loft",
               ("Chrome", "Concrete Grey"): "Slate Flat", ("Chrome", "Slate Flat"): "Concrete Grey",
               ("Glow-in-the-Dark", "Mint Flat"): "Vinyl Void", ("Mint Vinyl", "Mint Flat"): "Seafoam Flat",
               ("Mint Vinyl", "Seafoam Flat"): "Mint Flat", ("Neon Cream", "Cream Flat"): "Sky Flat",
               ("Neon Cream", "Butter Flat"): "Lavender Flat", ("Sky Vinyl", "Sky Flat"): "Peach Flat",
               ("Bubblegum", "Coral Flat"): "Mint Flat", ("Bubblegum", "Peach Flat"): "Sky Flat",
               ("Olive Glow", "Sage Flat"): "Lavender Flat"}


def _weighted(rng, layer: str, tier: str) -> str:
    ti = TIER_INDEX[tier]
    items = [(k, w[ti]) for k, w in LAYERS[layer].items() if w[ti] > 0]
    total = sum(w for _, w in items)
    x = rng() * total
    acc = 0.0
    for k, w in items:
        acc += w
        if x < acc:
            return k
    return items[-1][0]


def roll_art_traits(token_id: int, tier: str, attempt: int = 0) -> dict:
    salt = f"{CATALOG_SEED}:{ART_VERSION}:{token_id}" + (f":reroll:{attempt}" if attempt else "")
    rng = mulberry32(hash_seed(salt))
    t = {layer: _weighted(rng, layer, tier) for layer in VISUAL_LAYERS}
    # compatibility rule: opaque eyewear would hide the expression -> drop eyewear (deterministic)
    if t["Eyewear"] in OPAQUE_EYEWEAR and t["Eyes"] not in EYES_OK_UNDER_OPAQUE:
        t["Eyewear"] = "None"
    # contrast rule: metallic/holo fur on the same-family background disappears -> swap to a dark scene
    if (t["Fur"], t["Background"]) in CLASH_PAIRS:
        t["Background"] = CLASH_PAIRS[(t["Fur"], t["Background"])]
    return t


_CATALOG = None


def build_catalog() -> list[dict]:
    """Full deterministic 10k catalog. Tokens are processed in ascending id; if a token's visual combo
    (all VISUAL_LAYERS) already exists, it is re-rolled with salt ':reroll:k' (k=1,2,..) until unique."""
    global _CATALOG
    if _CATALOG is not None:
        return _CATALOG
    seen: set[tuple] = set()
    out = []
    for tid in range(1, COLLECTION_SIZE + 1):
        tier = token_rarity(tid)
        for attempt in range(MAX_REROLLS):
            t = roll_art_traits(tid, tier, attempt)
            key = tuple(t[l] for l in VISUAL_LAYERS)
            if key not in seen:
                break
        else:
            raise RuntimeError(f"could not find unique combo for token {tid}")
        seen.add(key)
        out.append({"token_id": tid, "rarity": tier, "traits": t, "rerolls": attempt,
                    "catchphrase": demo_traits(tid)["catchphrase"]})
    _CATALOG = out
    return out


def token_entry(token_id: int) -> dict:
    return build_catalog()[token_id - 1]


# Image base = prefix placed directly before "{id}.webp" (the images directory root).
# Placeholder until the WebP folder is published to IPFS; swap with `greencat_art.py metadata --base ipfs://<CID>/`
# (tools/upload_nftstorage.mjs does this automatically).
IMAGES_CID_PLACEHOLDER = "__IMAGES_CID__"
DEFAULT_BASE_URI = f"ipfs://{IMAGES_CID_PLACEHOLDER}/"
IMAGE_EXT = "webp"
IMAGE_MIME = "image/webp"


def image_uri(token_id: int, base: str = DEFAULT_BASE_URI) -> str:
    return f"{base if base.endswith('/') else base + '/'}{token_id}.{IMAGE_EXT}"


def metadata_json(entry: dict, base: str = DEFAULT_BASE_URI) -> dict:
    tid, rarity, t = entry["token_id"], entry["rarity"], entry["traits"]
    label = RARITY_LABELS[rarity]
    image = image_uri(tid, base)
    bits = [f"{label} GreenCat", t["Background"], f"{t['Fur']} fur", f"{t['Eyes']} eyes"]
    for k in ("Eyewear", "Hat", "Accessory", "Aura"):
        if t[k] != "None":
            bits.append(t[k])
    bits.append(f"\u201c{entry['catchphrase']}\u201d")
    attrs = [{"trait_type": "Rarity", "value": label}]
    attrs += [{"trait_type": k, "value": t[k]} for k in VISUAL_LAYERS]
    attrs += [{"trait_type": "Catchphrase", "value": entry["catchphrase"]},
              {"trait_type": "Catalog Seed", "value": CATALOG_SEED},
              {"trait_type": "Token ID", "value": str(tid)}]
    return {
        "name": f"GreenCat #{tid}",
        "symbol": "GCAT",
        "description": " \u00b7 ".join(bits),
        "image": image,
        "external_url": "https://www.greencat69420.com",
        "attributes": attrs,
        "properties": {"category": "image", "files": [{"uri": image, "type": IMAGE_MIME}]},
        "_greencat": {"draft": True, "artVersion": ART_VERSION, "rarity": rarity, "catalogSeed": CATALOG_SEED,
                      "rerolls": entry["rerolls"],
                      "note": "Final art-v1. Image base is a placeholder until IPFS upload (see art/UPLOAD-PLAN.md)."},
    }


if __name__ == "__main__":
    tbl = rarity_table()
    print({r: tbl.count(r) for r in RARITY_ORDER})
    print(json.dumps(token_entry(1), indent=1))
