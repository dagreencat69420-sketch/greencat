"""Export every trait value as a standalone 1024x1024 transparent PNG under art/layers/<Layer>/<value>.png
(reference / hand-off for designers who may later replace programmatic art with painted art at the same
registration). Body layers (Fur, Eyes) include the cat; overlays are on transparent canvas."""
import os, re, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from PIL import Image
import catalog as C, render as R

def slug(v): return re.sub(r"[^a-z0-9]+", "-", v.lower()).strip("-")
base = {"Background": "Concrete Grey", "Fur": "Lime Vinyl", "Eyes": "Grumpy", "Eyewear": "None", "Hat": "None", "Accessory": "None", "Aura": "None"}
def fin(c): return c.resize((R.OUT, R.OUT), Image.LANCZOS)
for layer in C.VISUAL_LAYERS:
    d = os.path.join(R.ART, "layers", layer); os.makedirs(d, exist_ok=True)
    for v in C.LAYERS[layer]:
        if v == "None": continue
        rng = R.token_rng(7)
        t = dict(base); t[layer] = v
        if layer == "Background":
            out = fin(R.background(v, rng))
        else:
            cat = R.build_cat(t, rng)
            canvas = R.new_layer()
            if layer in ("Fur", "Eyes"):
                canvas.alpha_composite(cat, (int(round(R.CX0 * R.SS)), int(round(R.CY0 * R.SS))))
                if v == "Laser Eyes": R.laser_beams(canvas, "None")
            elif layer == "Eyewear": R.eyewear(canvas, v, "Grumpy")
            elif layer == "Hat": R.hat(canvas, v, rng)
            elif layer == "Accessory":
                R.accessory(canvas, v, behind=True); R.accessory(canvas, v, behind=False)
            elif layer == "Aura":
                ca = R.cat_alpha_canvas(cat); R.aura_behind(canvas, v, ca, "Lime Vinyl")
                if v == "Sparkles": R.sparkles_front(canvas, ca, rng)
            out = fin(canvas)
        out.save(os.path.join(d, slug(v) + ".png"))
    print(layer, len(os.listdir(d)))
