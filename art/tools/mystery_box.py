#!/usr/bin/env python3
"""Mystery-box (unrevealed) + collection art options for GreenCat (phase 1: local only, nothing uploaded).
Reuses render.py (same 1024 canvas, 2x supersampling, base cat, backgrounds, glow/vinyl helpers).
Usage (from art/): .venv/bin/python tools/mystery_box.py   -> out/mystery/*.png|*.webp + preview-sheet.png"""
import os, sys, math, random
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageChops
ART = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ART)
import render as R
from render import S, SS, OUT, new_layer, add_glow, fast_blur, vinylize, font, background, build_cat, cat_alpha_canvas, ground_shadow

DST = os.path.join(ART, "out", "mystery")
LIME = (184, 255, 60)
MAGENTA = (255, 60, 210)
BASE_TRAITS = {"Background": "Lime Nebula", "Fur": "Lime Vinyl", "Eyes": "Grumpy", "Eyewear": "None",
               "Hat": "None", "Accessory": "None", "Aura": "None"}
X = lambda v: v * SS   # 1024-units -> supersampled px


def save(img, name):
    rgb = img.convert("RGB").resize((OUT, OUT), Image.LANCZOS) if img.width != OUT else img.convert("RGB")
    rgb.save(os.path.join(DST, f"{name}.png"), optimize=True)
    rgb.save(os.path.join(DST, f"{name}.webp"), "WEBP", quality=92, method=6)   # same as tools/convert_webp.py
    return rgb


def neon_text(canvas, text, cx, cy, size, col, fnt="Anton-Regular.ttf", glow=18, core=(255, 255, 255)):
    f = font(fnt, X(size))
    lay = new_layer(); d = ImageDraw.Draw(lay)
    d.text((X(cx), X(cy)), text, font=f, fill=col + (255,), anchor="mm")
    add_glow(canvas, lay, X(glow), 1.4, 2)
    inner = new_layer(); d2 = ImageDraw.Draw(inner)
    d2.text((X(cx), X(cy)), text, font=f, fill=core + (255,), anchor="mm", stroke_width=0)
    inner = inner.filter(ImageFilter.MinFilter(5))   # thin hot core
    canvas.alpha_composite(Image.blend(Image.new("RGBA", inner.size, (0, 0, 0, 0)), inner, 0.75))


def qmark(canvas, cx, cy, size, col, glow=26):
    neon_text(canvas, "?", cx, cy, size, col, "ChakraPetch-Bold.ttf", glow)


def stars(canvas, rng, n=40, region=(0, 0, 1024, 700)):
    d = ImageDraw.Draw(canvas)
    for _ in range(n):
        x, y = rng.uniform(region[0], region[2]), rng.uniform(region[1], region[3])
        r = rng.uniform(4, 14)
        R.sparkle(d, X(x), X(y), X(r), (255, 255, 235, int(rng.uniform(120, 230))))


def shade_poly(lay, pts, col):
    ImageDraw.Draw(lay).polygon([(X(x), X(y)) for x, y in pts], fill=col)


# ---------------------------------------------------------------- A: glossy gift box with cat-ear lid
def option_a():
    rng = random.Random(1)
    canvas = background("Vinyl Void", rng)
    # lime glow pool behind box
    pool = new_layer(); ImageDraw.Draw(pool).ellipse([X(212), X(250), X(812), X(850)], fill=LIME + (90,))
    canvas.alpha_composite(fast_blur(pool, X(90)))
    stars(canvas, rng, 18, (60, 60, 964, 420))
    # floor shadow
    sh = new_layer(); ImageDraw.Draw(sh).ellipse([X(250), X(842), X(774), X(902)], fill=(0, 0, 0, 170))
    canvas.alpha_composite(fast_blur(sh, X(14)))
    # box body (front + right side, slight 3/4)
    body_front = [(262, 520), (690, 520), (690, 868), (262, 868)]
    body_side = [(690, 520), (782, 482), (782, 822), (690, 868)]
    lid_front = [(236, 432), (716, 432), (716, 540), (236, 540)]
    lid_side = [(716, 432), (808, 394), (808, 500), (716, 540)]
    lid_top = [(236, 432), (328, 394), (808, 394), (716, 432)]
    box = new_layer()
    shade_poly(box, body_front, (110, 214, 40, 255))
    shade_poly(box, body_side, (62, 150, 26, 255))
    # cat ears on lid (front-facing triangles rising from lid top)
    ears = new_layer()
    for (bx0, bx1, tip) in ((290, 470, (318, 236)), (580, 760, (742, 236))):
        shade_poly(ears, [(bx0, 416), tip, (bx1, 416)], (126, 228, 48, 255))
    ears_in = new_layer()
    for (bx0, bx1, tip) in ((325, 445, (338, 292)), (612, 728, (724, 292))):
        shade_poly(ears_in, [(bx0, 412), tip, (bx1, 412)], (70, 150, 30, 255))
    lid = new_layer()
    shade_poly(lid, lid_top, (170, 248, 80, 255))
    shade_poly(lid, lid_front, (132, 232, 52, 255))
    shade_poly(lid, lid_side, (76, 168, 30, 255))
    for L in (ears, box, lid):
        L2 = vinylize(L, 0.6, 9)
        canvas.alpha_composite(L2)
        if L is ears:
            canvas.alpha_composite(vinylize(ears_in, 0.4, 5))
    # ribbon (deep forest green vinyl) vertical + horizontal on front, + side band
    rib = new_layer()
    shade_poly(rib, [(436, 432), (516, 432), (516, 540), (436, 540)], (24, 84, 40, 255))
    shade_poly(rib, [(500, 394), (560, 394), (516, 432), (436, 432)], (30, 100, 48, 255))
    shade_poly(rib, [(690, 548), (782, 510), (782, 558), (690, 596)], (14, 54, 26, 255))
    shade_poly(rib, [(262, 548), (690, 548), (690, 596), (262, 596)], (20, 70, 34, 255))
    canvas.alpha_composite(vinylize(rib, 0.5, 6))
    # specular glints
    gl = new_layer(); d = ImageDraw.Draw(gl)
    d.rounded_rectangle([X(280), X(538), X(300), X(840)], X(10), fill=(255, 255, 255, 70))
    d.rounded_rectangle([X(252), X(446), X(420), X(458)], X(6), fill=(255, 255, 255, 110))
    canvas.alpha_composite(fast_blur(gl, X(3)))
    # neon "?" on the front panel
    qmark(canvas, 476, 735, 250, MAGENTA, 24)
    neon_text(canvas, "$GreenCat", 512, 960, 64, LIME, glow=14)
    return canvas


# ---------------------------------------------------------------- B: silhouette + glowing ?
def option_b():
    rng = random.Random(2)
    canvas = background("Neon Alley", rng)
    cat = build_cat(BASE_TRAITS, rng)
    ca = cat_alpha_canvas(cat)
    # lime rim-glow behind
    glow = Image.merge("RGBA", (*[Image.new("L", (S, S), c) for c in LIME], ca))
    big = fast_blur(glow.filter(ImageFilter.MaxFilter(9)), X(22))
    canvas.alpha_composite(big); canvas.alpha_composite(big)
    ground_shadow(canvas, True)
    # dark silhouette keeping a hint of vinyl shading
    arr = np.asarray(cat).astype(np.float32)
    L = (0.3 * arr[..., 0] + 0.59 * arr[..., 1] + 0.11 * arr[..., 2]) / 255
    dark = np.dstack([10 + 26 * L ** 2, 16 + 40 * L ** 2, 14 + 30 * L ** 2, arr[..., 3]])
    sil = Image.fromarray(dark.clip(0, 255).astype(np.uint8), "RGBA")
    canvas.alpha_composite(sil, (int(round(R.CX0 * SS)), int(round(R.CY0 * SS))))
    # thin rim light on the silhouette edge
    a = ca.filter(ImageFilter.GaussianBlur(X(3)))
    edge = ImageChops.subtract(ca, ca.filter(ImageFilter.MinFilter(9)))
    rim = Image.merge("RGBA", (*[Image.new("L", (S, S), c) for c in (210, 255, 120)], edge.point(lambda v: int(v * 0.8))))
    canvas.alpha_composite(rim)
    qmark(canvas, 512, 470, 330, LIME, 30)
    neon_text(canvas, "$GreenCat", 512, 110, 70, MAGENTA, glow=16)
    return canvas


# ---------------------------------------------------------------- C: cardboard blind box
def kraft(lay_shape, base_col, rng, seed):
    """Fill an alpha shape with a kraft-cardboard texture (noise + fibres)."""
    a = np.asarray(lay_shape.getchannel("A")).astype(np.float32) / 255
    h, w = a.shape
    g = np.random.default_rng(seed)
    n = g.normal(0, 1, (h // 4, w // 4)).astype(np.float32)
    n = np.asarray(Image.fromarray(((n * 20) + 128).clip(0, 255).astype(np.uint8)).resize((w, h), Image.BILINEAR)).astype(np.float32) - 128
    fib = g.normal(0, 1, (h // 2, w // 16)).astype(np.float32)
    fib = np.asarray(Image.fromarray(((fib * 25) + 128).clip(0, 255).astype(np.uint8)).resize((w, h), Image.BICUBIC)).astype(np.float32) - 128
    rgb = np.array(base_col, np.float32)[None, None, :] + (n * 0.35 + fib * 0.25)[..., None]
    return Image.fromarray(np.dstack([rgb.clip(0, 255), a * 255]).astype(np.uint8), "RGBA")


def option_c():
    rng = random.Random(3)
    canvas = background("Mint Flat", rng)
    sh = new_layer(); ImageDraw.Draw(sh).polygon([(X(x), X(y)) for x, y in [(230, 900), (700, 900), (840, 850), (380, 846)]], fill=(0, 0, 0, 110))
    canvas.alpha_composite(fast_blur(sh, X(16)))
    front = [(230, 330), (650, 330), (650, 900), (230, 900)]
    side = [(650, 330), (800, 250), (800, 820), (650, 900)]
    top = [(230, 330), (380, 250), (800, 250), (650, 330)]
    for pts, col, sd in ((front, (196, 154, 104), 1), (side, (150, 112, 70), 2), (top, (214, 176, 128), 3)):
        m = new_layer(); shade_poly(m, pts, (255, 255, 255, 255))
        canvas.alpha_composite(kraft(m, col, rng, sd))
    d = ImageDraw.Draw(canvas)
    # tuck flap + edges
    d.line([(X(230), X(330)), (X(650), X(330)), (X(800), X(250))], fill=(110, 80, 48, 255), width=X(3))
    d.line([(X(650), X(330)), (X(650), X(900))], fill=(110, 80, 48, 255), width=X(3))
    d.ellipse([X(490), X(278), X(560), X(300)], fill=(90, 64, 38, 255))   # hang-tab hole
    # printed lime band + window with a dim cat silhouette and big "?"
    pr = new_layer(); dp = ImageDraw.Draw(pr)
    dp.rectangle([X(230), X(360), X(650), X(450)], fill=(140, 230, 50, 235))
    dp.rounded_rectangle([X(262), X(470), X(618), X(800)], X(26), fill=(16, 26, 18, 245))
    canvas.alpha_composite(pr)
    # cat silhouette inside window (scaled base cat)
    cat = build_cat(BASE_TRAITS, rng)
    sc = 0.36
    cw, chh = int(cat.width * sc), int(cat.height * sc)
    small = cat.resize((cw, chh), Image.LANCZOS)
    arr = np.asarray(small).astype(np.float32)
    sil = Image.fromarray(np.dstack([np.full(arr.shape[:2], 40), np.full(arr.shape[:2], 70), np.full(arr.shape[:2], 46), arr[..., 3] * 0.9]).astype(np.uint8), "RGBA")
    canvas.alpha_composite(sil, (X(440) - cw // 2, X(790) - chh))
    qmark(canvas, 440, 610, 230, LIME, 20)
    f = font("Anton-Regular.ttf", X(64))
    d.text((X(440), X(404)), "$GreenCat", font=f, fill=(14, 40, 18, 255), anchor="mm")
    f2 = font("ChakraPetch-Bold.ttf", X(26))
    d.text((X(440), X(838)), "BLIND BOX · SERIES 1", font=f2, fill=(60, 40, 22, 255), anchor="mm")
    d.text((X(440), X(872)), "1 OF 10,000 · LO-FI EDITION", font=font("ChakraPetch-Bold.ttf", X(20)), fill=(80, 56, 32, 230), anchor="mm")
    # side panel print (skewed) : vertical lime stripe + paw
    sp = new_layer(); ImageDraw.Draw(sp).polygon([(X(x), X(y)) for x, y in [(690, 309), (760, 271), (760, 380), (690, 418)]], fill=(140, 230, 50, 220))
    canvas.alpha_composite(sp)
    # lid sheen
    gl = new_layer(); ImageDraw.Draw(gl).polygon([(X(x), X(y)) for x, y in top], fill=(255, 255, 255, 40))
    canvas.alpha_composite(gl)
    return canvas


# ---------------------------------------------------------------- collection images
def collection_1():
    """Base lime-vinyl GreenCat, Lime Glow aura, Lime Nebula + neon $GreenCat sign (logo-ish)."""
    rng = random.Random(4)
    canvas = background("Lo-fi Night", rng)
    cat = build_cat(BASE_TRAITS, rng)
    ca = cat_alpha_canvas(cat)
    R.aura_behind(canvas, "Lime Glow", ca, "Lime Vinyl")
    ground_shadow(canvas, True)
    canvas.alpha_composite(cat, (int(round(R.CX0 * SS)), int(round(R.CY0 * SS))))
    neon_text(canvas, "$GreenCat", 512, 110, 96, LIME, glow=18)
    return canvas


def collection_2():
    """Clean hero: base GreenCat on Lime Nebula with sparkles, no text (closest to the 10k renders)."""
    t = dict(BASE_TRAITS, Aura="Sparkles", Background="Lime Nebula")
    rng = random.Random(5)
    canvas = R.background(t["Background"], rng)
    cat = build_cat(t, rng); ca = cat_alpha_canvas(cat)
    R.aura_behind(canvas, "Lime Glow", ca, t["Fur"])
    ground_shadow(canvas, True)
    canvas.alpha_composite(cat, (int(round(R.CX0 * SS)), int(round(R.CY0 * SS))))
    R.sparkles_front(canvas, ca, rng)
    return canvas


def sheet(items):
    from PIL import ImageFont
    tile, pad, lab = 400, 24, 56
    cols = 3
    rows = math.ceil(len(items) / cols)
    W = cols * tile + (cols + 1) * pad
    H = 90 + rows * (tile + lab + pad) + pad
    sh = Image.new("RGB", (W, H), (10, 18, 12))
    d = ImageDraw.Draw(sh)
    d.text((W // 2, 46), "GreenCat · mystery box + collection options (phase 1 draft)", font=ImageFont.truetype(os.path.join(ART, "fonts", "ChakraPetch-Bold.ttf"), 30), fill=LIME, anchor="mm")
    f = ImageFont.truetype(os.path.join(ART, "fonts", "ChakraPetch-Bold.ttf"), 20)
    for i, (label, im) in enumerate(items):
        x = pad + (i % cols) * (tile + pad); y = 90 + (i // cols) * (tile + lab + pad)
        sh.paste(im.resize((tile, tile), Image.LANCZOS), (x, y))
        d.text((x + tile // 2, y + tile + 26), label, font=f, fill=(225, 255, 210), anchor="mm")
    sh.save(os.path.join(DST, "preview-sheet.png"), optimize=True)


if __name__ == "__main__":
    os.makedirs(DST, exist_ok=True)
    out = []
    for name, label, fn in (("mystery-a-giftbox", "A · cat-ear gift box", option_a),
                            ("mystery-b-silhouette", "B · shadow cat + neon ?", option_b),
                            ("mystery-c-blindbox", "C · cardboard blind box", option_c),
                            ("collection-1-neon-sign", "Collection 1 · neon sign", collection_1),
                            ("collection-2-hero", "Collection 2 · clean hero", collection_2)):
        out.append((label, save(fn(), name))); print("wrote", name)
    # reference: a real collection render for scale/consistency
    ref = os.path.join(ART, "out", "images-webp", "1.webp")
    if os.path.exists(ref):
        out.append(("ref · real token #1", Image.open(ref).convert("RGB")))
    sheet(out); print("wrote preview-sheet.png")
