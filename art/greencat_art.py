#!/usr/bin/env python3
"""GreenCat 10k art pipeline (art-v1) - CLI.

  python greencat_art.py verify                       # parity vs demo/SDK/rarity.rs + uniqueness
  python greencat_art.py metadata [--base URI]        # all 10k metadata JSON + distribution report (no images)
  python greencat_art.py samples                      # render the phase-1 sample set + contact sheet
  python greencat_art.py render --ids 1,42,100        # render specific tokens
  python greencat_art.py render --all --workers 6     # FULL 10k render (phase 2 - do not run until art approved)
  python greencat_art.py bench --n 24 --workers 6     # timing/disk estimate
  python greencat_art.py check --deep                 # verify all 10k PNGs + matching metadata
  python greencat_art.py spotcheck --n 48             # random-token contact sheet -> out/spotcheck-sheet.png

Outputs (under art/):
  out/metadata/{id}.json   Metaplex-style JSON (name 'GreenCat #N', Rarity + traits, placeholder image URI)
  out/images/{id}.png      1024x1024 PNG (full render only)
  out/catalog-art-v1.json  compact token -> rarity/traits table (for SDK/demo port)
  reports/distribution.md|json  trait counts across all 10k, computed from metadata only
  samples/                 sample PNGs + metadata + contact-sheet.png
"""
from __future__ import annotations
import argparse, json, os, sys, time, shutil
from collections import Counter, defaultdict
from concurrent.futures import ProcessPoolExecutor

ART = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ART)
import catalog as C

OUT = os.path.join(ART, "out")
SAMPLES = os.path.join(ART, "samples")
REPORTS = os.path.join(ART, "reports")


def cmd_verify(_):
    import subprocess
    return subprocess.call([sys.executable, os.path.join(ART, "tools", "verify_parity.py")])


def write_metadata(base, md_dir=None):
    cat = C.build_catalog()
    md_dir = md_dir or os.path.join(OUT, "metadata")
    os.makedirs(md_dir, exist_ok=True)
    for e in cat:
        with open(os.path.join(md_dir, f"{e['token_id']}.json"), "w") as f:
            json.dump(C.metadata_json(e, base), f, indent=2, ensure_ascii=False)
            f.write("\n")
    compact = [{"id": e["token_id"], "rarity": e["rarity"], **e["traits"], "catchphrase": e["catchphrase"]} for e in cat]
    with open(os.path.join(OUT, "catalog-art-v1.json"), "w") as f:
        json.dump({"catalogSeed": C.CATALOG_SEED, "artVersion": C.ART_VERSION, "tokens": compact}, f, separators=(",", ":"))
    return md_dir


def distribution_report(md_dir):
    """Counts computed purely from the metadata JSON files (no rendering)."""
    by_trait = defaultdict(Counter)
    by_tier_trait = defaultdict(lambda: defaultdict(Counter))
    combos = set(); n = 0
    for tid in range(1, C.COLLECTION_SIZE + 1):
        md = json.load(open(os.path.join(md_dir, f"{tid}.json")))
        attrs = {a["trait_type"]: a["value"] for a in md["attributes"]}
        assert md["name"] == f"GreenCat #{tid}"
        r = attrs["Rarity"]; n += 1
        by_trait["Rarity"][r] += 1
        for layer in C.VISUAL_LAYERS:
            by_trait[layer][attrs[layer]] += 1
            by_tier_trait[layer][attrs[layer]][r] += 1
        by_trait["Catchphrase"][attrs["Catchphrase"]] += 1
        combos.add(tuple(attrs[l] for l in C.VISUAL_LAYERS))
    tiers = ["Common", "Uncommon", "Rare", "Legendary"]
    lines = ["# GreenCat art-v1 - trait / rarity distribution (all 10,000 tokens)", "",
             f"Computed from `art/out/metadata/*.json` only (no images rendered). Seed `{C.CATALOG_SEED}`, art version `{C.ART_VERSION}`.", "",
             f"- Tokens: **{n}**  |  unique visual trait combos: **{len(combos)}** (duplicates: {n - len(combos)})",
             "- Rarity tiers: " + ", ".join(f"{t} **{by_trait['Rarity'][t]}**" for t in tiers), ""]
    for layer in C.VISUAL_LAYERS + ["Catchphrase"]:
        lines += [f"## {layer}", "", "| Value | Total | % of 10k | " + " | ".join(tiers) + " |", "|---|---:|---:|" + "---:|" * 4]
        for v, c in sorted(by_trait[layer].items(), key=lambda kv: -kv[1]):
            per = [str(by_tier_trait[layer][v][t]) if layer != "Catchphrase" else "" for t in tiers]
            lines.append(f"| {v} | {c} | {c / n * 100:.2f}% | " + " | ".join(per) + " |")
        lines.append("")
    os.makedirs(REPORTS, exist_ok=True)
    open(os.path.join(REPORTS, "distribution.md"), "w").write("\n".join(lines))
    json.dump({"tokens": n, "uniqueCombos": len(combos), "counts": {k: dict(v) for k, v in by_trait.items()},
               "byTier": {l: {v: dict(c) for v, c in d.items()} for l, d in by_tier_trait.items()}},
              open(os.path.join(REPORTS, "distribution.json"), "w"), indent=1)
    return by_trait, len(combos)


def cmd_metadata(a):
    t = time.time()
    md = write_metadata(a.base, a.out)
    if a.out:
        print(f"metadata: 10000 files -> {md} (base={a.base})"); return
    by_trait, uniq = distribution_report(md)
    print(f"metadata: 10000 files -> {md} ({time.time() - t:.1f}s); unique combos {uniq}; tiers {dict(by_trait['Rarity'])}")
    print(f"report -> {os.path.join(REPORTS, 'distribution.md')}")


def _render_one(args):
    tid, out_dir, skip = args
    import render as R
    p = os.path.join(out_dir, f"{tid}.png")
    if skip and os.path.exists(p):
        return tid, 0.0, os.path.getsize(p)
    t = time.time()
    R.render_token(tid).save(p, optimize=False, compress_level=6)
    return tid, time.time() - t, os.path.getsize(p)


def render_many(ids, out_dir, workers, skip=True):
    os.makedirs(out_dir, exist_ok=True)
    t0 = time.time(); sizes = []
    jobs = [(i, out_dir, skip) for i in ids]
    if workers <= 1:
        res = map(_render_one, jobs)
    else:
        ex = ProcessPoolExecutor(workers); res = ex.map(_render_one, jobs, chunksize=4)
    for k, (tid, dt, sz) in enumerate(res, 1):
        sizes.append(sz)
        if k % 100 == 0 or k == len(ids):
            el = time.time() - t0
            print(f"  {k}/{len(ids)} rendered, {el:.0f}s elapsed, ETA {el / k * (len(ids) - k):.0f}s", flush=True)
    return time.time() - t0, sizes


def pick_samples():
    cat = C.build_catalog()
    must = {1, 42, 100, 5000}                           # parity spot-check ids from rarity.rs tests
    plan = {"common": 4, "uncommon": 4, "rare": 4, "legendary": 4}
    chosen = [cat[i - 1] for i in sorted(must)]
    seen = defaultdict(set)
    for e in chosen:
        for l in C.VISUAL_LAYERS:
            seen[l].add(e["traits"][l])
    for tier, n in plan.items():
        have = sum(1 for e in chosen if e["rarity"] == tier)
        pool = [e for e in cat if e["rarity"] == tier and e["token_id"] not in must]
        while have < n:
            best = max(pool, key=lambda e: (sum(e["traits"][l] not in seen[l] for l in C.VISUAL_LAYERS), -e["token_id"]))
            chosen.append(best); pool.remove(best); have += 1
            for l in C.VISUAL_LAYERS:
                seen[l].add(best["traits"][l])
    order = {"legendary": 0, "rare": 1, "uncommon": 2, "common": 3}
    return sorted(chosen, key=lambda e: (order[e["rarity"]], e["token_id"]))


def contact_sheet(entries, img_dir, path, cols=4, th=360, title=None):
    from PIL import Image, ImageDraw, ImageFont
    import render as R
    pad = 16; lab = 74; head = 90
    rows = (len(entries) + cols - 1) // cols
    W = cols * th + (cols + 1) * pad; H = head + rows * (th + lab + pad) + pad
    sheet = Image.new("RGB", (W, H), (14, 18, 14))
    d = ImageDraw.Draw(sheet)
    f1 = ImageFont.truetype(os.path.join(R.FONT_DIR, "DejaVuSans-Bold.ttf"), 30)
    f2 = ImageFont.truetype(os.path.join(R.FONT_DIR, "DejaVuSans-Bold.ttf"), 21)
    f3 = ImageFont.truetype(os.path.join(R.FONT_DIR, "DejaVuSans-Bold.ttf"), 14)
    d.text((pad, 18), title or "GreenCat 10k - art-v1 PHASE 1 SAMPLES (draft, for approval)", font=f1, fill=(184, 255, 0))
    d.text((pad, 58), f"seed {C.CATALOG_SEED} | tiers L100 / R900 / U2000 / C7000 | 1024x1024 renders shown at {th}px", font=f3, fill=(170, 190, 170))
    for i, e in enumerate(entries):
        x = pad + (i % cols) * (th + pad); y = head + (i // cols) * (th + lab + pad)
        im = Image.open(os.path.join(img_dir, f"{e['token_id']}.png")).resize((th, th), Image.LANCZOS)
        col = C.RARITY_COLORS[e["rarity"]]
        d.rectangle([x - 4, y - 4, x + th + 3, y + th + 3], fill=col)
        sheet.paste(im, (x, y))
        d.text((x, y + th + 8), f"#{e['token_id']}  {C.RARITY_LABELS[e['rarity']]}", font=f2, fill=col)
        t = e["traits"]
        l1 = f"{t['Fur']} | {t['Eyes']} | {t['Background']}"
        extras = [t[k] for k in ("Eyewear", "Hat", "Accessory", "Aura") if t[k] != "None"]
        def fit(txt):
            while d.textlength(txt, font=f3) > th and len(txt) > 4:
                txt = txt[:-2].rstrip() + "\u2026"
                txt = txt.replace("\u2026\u2026", "\u2026")
            return txt
        d.text((x, y + th + 36), fit(l1), font=f3, fill=(220, 230, 220))
        d.text((x, y + th + 54), fit(" | ".join(extras) or "no extras"), font=f3, fill=(160, 175, 160))
    sheet.save(path)
    return path


def cmd_samples(a):
    entries = pick_samples()
    os.makedirs(SAMPLES, exist_ok=True)
    ids = [e["token_id"] for e in entries]
    for fn in os.listdir(SAMPLES):                      # drop stale samples from earlier runs
        stem = fn.split(".")[0]
        if stem.isdigit() and int(stem) not in ids:
            os.remove(os.path.join(SAMPLES, fn))
    dt, sizes = render_many(ids, SAMPLES, a.workers, skip=False)
    for e in entries:
        json.dump(C.metadata_json(e, a.base), open(os.path.join(SAMPLES, f"{e['token_id']}.json"), "w"), indent=2, ensure_ascii=False)
    p = contact_sheet(entries, SAMPLES, os.path.join(SAMPLES, "contact-sheet.png"))
    print(f"samples {ids} in {dt:.1f}s; avg PNG {sum(sizes) / len(sizes) / 1e6:.2f} MB; contact sheet -> {p}")


def cmd_render(a):
    ids = list(range(1, C.COLLECTION_SIZE + 1)) if a.all else [int(x) for x in a.ids.split(",")]
    if a.all and not a.yes_full_render:
        sys.exit("Refusing full 10k render without --yes-full-render (phase 2; needs art approval first).")
    dt, sizes = render_many(ids, a.out, a.workers)
    print(f"rendered {len(ids)} in {dt:.0f}s -> {a.out}")


def cmd_check(a):
    """Verify the full render: every token has a non-empty, valid 1024x1024 PNG and matching metadata."""
    from PIL import Image
    img_dir = a.out; md_dir = os.path.join(OUT, "metadata")
    missing, empty, bad, md_bad = [], [], [], []
    total = 0
    for tid in range(1, C.COLLECTION_SIZE + 1):
        p = os.path.join(img_dir, f"{tid}.{a.ext}")
        if not os.path.exists(p):
            missing.append(tid); continue
        sz = os.path.getsize(p); total += sz
        if sz == 0:
            empty.append(tid); continue
        if a.deep:
            try:
                with Image.open(p) as im:
                    im.verify()
                with Image.open(p) as im:
                    if im.size != (1024, 1024): bad.append(tid)
            except Exception:
                bad.append(tid)
        mp = os.path.join(md_dir, f"{tid}.json")
        try:
            md = json.load(open(mp))
            e = C.token_entry(tid)
            attrs = {x["trait_type"]: x["value"] for x in md["attributes"]}
            ok = (md["name"] == f"GreenCat #{tid}" and md["image"].endswith(f"/{tid}.{C.IMAGE_EXT}")
                  and md["properties"]["files"][0] == {"uri": md["image"], "type": C.IMAGE_MIME}
                  and attrs["Rarity"] == C.RARITY_LABELS[e["rarity"]]
                  and all(attrs[l] == e["traits"][l] for l in C.VISUAL_LAYERS))
            if not ok: md_bad.append(tid)
        except Exception:
            md_bad.append(tid)
    res = {"images_dir": img_dir, "present": C.COLLECTION_SIZE - len(missing), "missing": len(missing), "empty": len(empty),
           "invalid_image": len(bad), "metadata_mismatch": len(md_bad), "total_bytes": total,
           "total_GB": round(total / 1e9, 3), "avg_MB": round(total / max(1, C.COLLECTION_SIZE - len(missing)) / 1e6, 3),
           "first_problems": (missing + empty + bad + md_bad)[:20]}
    print(json.dumps(res, indent=1))
    json.dump(res, open(os.path.join(REPORTS, "full-render-check.json"), "w"), indent=1)
    return 0 if not (missing or empty or bad or md_bad) else 1


def cmd_spotcheck(a):
    import random
    rnd = random.Random(a.seed)
    ids = sorted(rnd.sample(range(1, C.COLLECTION_SIZE + 1), a.n))
    entries = [C.token_entry(i) for i in ids]
    order = {"legendary": 0, "rare": 1, "uncommon": 2, "common": 3}
    entries.sort(key=lambda e: (order[e["rarity"]], e["token_id"]))
    p = contact_sheet(entries, a.out, os.path.join(OUT, "spotcheck-sheet.png"), cols=8, th=256,
                      title=f"GreenCat 10k art-v1 - FULL RENDER SPOT CHECK ({a.n} random tokens, seed {a.seed!r})")
    print(f"spot check {a.n} tokens -> {p}\nids: {ids}")
    print("tiers:", dict(Counter(e['rarity'] for e in entries)))


def cmd_bench(a):
    import tempfile
    cat = C.build_catalog()
    step = C.COLLECTION_SIZE // a.n
    ids = [cat[i * step]["token_id"] for i in range(a.n)]
    tmp = tempfile.mkdtemp(prefix="gc-bench-")
    dt, sizes = render_many(ids, tmp, a.workers, skip=False)
    shutil.rmtree(tmp)
    per = dt / len(ids); avg = sum(sizes) / len(sizes)
    est = per * C.COLLECTION_SIZE
    print(json.dumps({"tokens": len(ids), "workers": a.workers, "wall_s": round(dt, 1), "wall_per_token_s": round(per, 3),
                      "avg_png_MB": round(avg / 1e6, 3), "est_10k_wall_min": round(est / 60, 1),
                      "est_10k_images_GB": round(avg * C.COLLECTION_SIZE / 1e9, 2)}, indent=1))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("verify")
    m = sub.add_parser("metadata", help="--base = image base, i.e. prefix before {id}.webp (default placeholder ipfs://__IMAGES_CID__/)")
    m.add_argument("--base", default=os.environ.get("IMAGE_BASE_URI", C.DEFAULT_BASE_URI))
    m.add_argument("--out", default=None, help="write to another dir (no report), e.g. a staging dir")
    s = sub.add_parser("samples"); s.add_argument("--workers", type=int, default=4); s.add_argument("--base", default=os.environ.get("IMAGE_BASE_URI", C.DEFAULT_BASE_URI))
    r = sub.add_parser("render"); r.add_argument("--ids", default="1"); r.add_argument("--all", action="store_true")
    r.add_argument("--workers", type=int, default=4); r.add_argument("--out", default=os.path.join(OUT, "images"))
    r.add_argument("--yes-full-render", action="store_true")
    c = sub.add_parser("check"); c.add_argument("--out", default=os.path.join(OUT, "images-webp")); c.add_argument("--deep", action="store_true")
    c.add_argument("--ext", default="webp", choices=["webp", "png"])
    sp = sub.add_parser("spotcheck"); sp.add_argument("--n", type=int, default=48); sp.add_argument("--seed", default="greencat-spotcheck-2026-09-30")
    sp.add_argument("--out", default=os.path.join(OUT, "images"))
    b = sub.add_parser("bench"); b.add_argument("--n", type=int, default=24); b.add_argument("--workers", type=int, default=4)
    a = ap.parse_args()
    if getattr(a, "base", None) and not a.base.endswith("/"):
        a.base += "/"
    sys.exit({"verify": cmd_verify, "metadata": cmd_metadata, "samples": cmd_samples, "render": cmd_render, "bench": cmd_bench, "check": cmd_check, "spotcheck": cmd_spotcheck}[a.cmd](a) or 0)


if __name__ == "__main__":
    main()
