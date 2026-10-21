"""Debug: render every value of every layer on a neutral token -> art/layers/preview-<Layer>.png"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from PIL import Image, ImageDraw, ImageFont
import catalog as C, render as R
base = {"Background": "Concrete Grey", "Fur": "Lime Vinyl", "Eyes": "Grumpy", "Eyewear": "None", "Hat": "None", "Accessory": "None", "Aura": "None"}
layers = sys.argv[1:] or C.VISUAL_LAYERS
fnt = ImageFont.truetype(os.path.join(R.FONT_DIR, "DejaVuSans-Bold.ttf"), 20)
for layer in layers:
    vals = list(C.LAYERS[layer])
    th = 320; cols = 5; rows = (len(vals) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * th, rows * (th + 30)), (20, 20, 20))
    for i, v in enumerate(vals):
        t = dict(base); t[layer] = v
        if layer == "Eyes" and v == "Laser Eyes": pass
        im = R.render_traits(t, 7).resize((th, th), Image.LANCZOS)
        x, y = (i % cols) * th, (i // cols) * (th + 30)
        sheet.paste(im, (x, y)); ImageDraw.Draw(sheet).text((x + 6, y + th + 4), v, font=fnt, fill=(255, 255, 255))
    p = os.path.join(R.ART, "layers", f"preview-{layer}.png"); sheet.save(p); print(p)
