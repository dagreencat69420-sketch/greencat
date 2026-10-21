"""Verify art/catalog.py against the demo+SDK dump (art/out/reference-demo-catalog.json, made by
`npx tsx art/tools/dump_reference.mts art/out/reference-demo-catalog.json`) and rarity.rs test vectors."""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import catalog as C
ref = json.load(open(os.path.join(os.path.dirname(__file__), "..", "out", "reference-demo-catalog.json")))
bad_r = sum(1 for e in ref if C.token_rarity(e["id"]) != e["rarity"])
bad_t = sum(1 for e in ref if C.demo_traits(e["id"]) != {k: e[k] for k in ("background","fur","eyes","hat","accessory","catchphrase")})
rust = {1:"common",2:"common",3:"common",42:"rare",100:"uncommon",500:"uncommon",1000:"common",5000:"rare",9999:"common",10000:"common"}
bad_rust = [i for i, r in rust.items() if C.token_rarity(i) != r]
assert C.hash_seed(C.CATALOG_SEED) == 3574348136
cat = C.build_catalog()
counts = {}
for e in cat: counts[e["rarity"]] = counts.get(e["rarity"], 0) + 1
combos = {tuple(e["traits"][l] for l in C.VISUAL_LAYERS) for e in cat}
print(f"tokens checked: {len(ref)}; rarity mismatches vs demo/SDK: {bad_r}; demo-trait/catchphrase mismatches: {bad_t}; rarity.rs vector mismatches: {bad_rust}")
print("tier counts:", counts, "| unique visual combos:", len(combos), "| tokens re-rolled:", sum(1 for e in cat if e["rerolls"]))
ok = bad_r == 0 and bad_t == 0 and not bad_rust and counts == C.RARITY_COUNTS and len(combos) == 10000
print("PARITY OK" if ok else "PARITY FAILED"); sys.exit(0 if ok else 1)
