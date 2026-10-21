"""GreenCat art-v1 renderer: token_id -> traits (catalog.py) -> 1024x1024 PNG.

All trait art is PROGRAMMATIC (Pillow/numpy) on top of a single base render extracted from the
user's reference sheet (base/greencat-base-front.png), so every token stays on-model.
Rendering is supersampled at 2048 and downsampled to 1024 for anti-aliasing. Deterministic:
the same token_id always yields the same pixels (per-token RNG seeded from the catalog seed).
"""
from __future__ import annotations
import math, os, colorsys
from functools import lru_cache
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageChops
from scipy import ndimage as ndi
import catalog as C

ART = os.path.dirname(os.path.abspath(__file__))
BASE_PATH = os.path.join(ART, "base", "greencat-base-front.png")
OUT = 1024
SS = 2
S = OUT * SS
FONT_DIR = os.path.join(ART, "fonts")
CAT_SCALE = 0.92                      # 1024-canvas px per base px
BASE_W, BASE_H = Image.open(BASE_PATH).size if os.path.exists(BASE_PATH) else (567, 860)
CX0 = (OUT - BASE_W * CAT_SCALE) / 2  # 1024-units
CY0 = 188.0
K = CAT_SCALE * SS                    # supersampled px per base px

# base-render landmarks (base px)
EYE_L_BOX = (105, 215, 240, 330)
EYE_R_BOX = (320, 225, 460, 330)
EYE_L_C = (175, 274)
EYE_R_C = (384, 274)
PUPIL_L = (192, 272)
PUPIL_R = (372, 272)
FUR_RGB = (96, 169, 91)
L_LO, L_HI = 0.20, 0.88               # body luminance range used to normalise shading


def P(x, y):
    return (CX0 * SS + x * K, CY0 * SS + y * K)


def U(v):
    return v * K


def hexc(h, a=255):
    h = h.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), a)


def font(name, size):
    return ImageFont.truetype(os.path.join(FONT_DIR, name), int(size))


def new_layer():
    return Image.new("RGBA", (S, S), (0, 0, 0, 0))


def fast_blur(img: Image.Image, radius: float) -> Image.Image:
    f = 4 if radius >= 12 else 1
    if f == 1:
        return img.filter(ImageFilter.GaussianBlur(radius))
    small = img.resize((img.width // f, img.height // f), Image.BILINEAR)
    small = small.filter(ImageFilter.GaussianBlur(radius / f))
    return small.resize(img.size, Image.BILINEAR)


def add_glow(canvas: Image.Image, layer: Image.Image, radius=24, strength=1.0, passes=2):
    g = fast_blur(layer, radius)
    if strength != 1.0:
        a = g.getchannel("A").point(lambda v: min(255, int(v * strength)))
        g.putalpha(a)
    for _ in range(passes):
        canvas.alpha_composite(g)
    canvas.alpha_composite(layer)


def vinylize(layer: Image.Image, strength=0.55, sigma=7.0) -> Image.Image:
    """Fake 3D 'glossy vinyl' lighting for flat vector overlays: bevel from blurred-alpha normals
    (light from top-left) + soft top-to-bottom falloff. Keeps overlays closer to the toy render."""
    small = layer.resize((S // 2, S // 2), Image.BILINEAR)
    arr = np.asarray(small).astype(np.float32)
    a = arr[..., 3] / 255
    if a.max() == 0:
        return layer
    b = ndi.gaussian_filter(a, sigma)
    gy, gx = np.gradient(b)
    n = np.sqrt(gx ** 2 + gy ** 2) + 1e-6
    lit = (-(gx * -0.6) - (gy * -0.8))     # light dir (-0.6,-0.8) => from top-left
    lit = np.clip(lit / (n.max() + 1e-6) * 3.0, -1, 1)
    hi = np.clip(lit, 0, 1)[..., None]; sh = np.clip(-lit, 0, 1)[..., None]
    rgb = arr[..., :3]
    rgb = rgb * (1 - strength * 0.8 * sh) + (255 - rgb) * strength * 0.7 * hi
    # interior falloff: darker toward the bottom of each shape
    inner = ndi.gaussian_filter(a, sigma * 3)
    rgb = rgb * (0.82 + 0.18 * np.clip(inner * 1.4, 0, 1))[..., None]
    out = np.dstack([np.clip(rgb, 0, 255), arr[..., 3]]).astype(np.uint8)
    big = Image.fromarray(out, "RGBA").resize((S, S), Image.BILINEAR)
    big.putalpha(layer.getchannel("A"))
    return big


def lin_grad(w, h, stops, axis="y", angle=None):
    """stops: list of (pos, (r,g,b)). returns HxWx3 float array."""
    if angle is not None:
        yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
        ca, sa = math.cos(math.radians(angle)), math.sin(math.radians(angle))
        t = (xx / w - .5) * ca + (yy / h - .5) * sa
        t = (t - t.min()) / (t.max() - t.min())
    elif axis == "y":
        t = np.repeat(np.linspace(0, 1, h, dtype=np.float32)[:, None], w, 1)
    else:
        t = np.repeat(np.linspace(0, 1, w, dtype=np.float32)[None, :], h, 0)
    return gmap(t, stops)


def gmap(t, stops):
    pos = [p for p, _ in stops]
    out = np.empty(t.shape + (3,), np.float32)
    for c in range(3):
        out[..., c] = np.interp(t, pos, [col[c] for _, col in stops])
    return out


def radial(w, h, cx, cy, r):
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    return np.clip(np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2) / r, 0, 1)


def to_img(arr):
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "RGB").convert("RGBA")


# =============================== BASE CAT ASSETS ===============================
@lru_cache(maxsize=1)
def cat_assets():
    base = Image.open(BASE_PATH).convert("RGBA")
    W, H = round(BASE_W * K), round(BASE_H * K)
    arr = np.asarray(base).astype(np.float32)
    # premultiplied resize to avoid dark fringes
    pm = arr.copy(); pm[..., :3] *= pm[..., 3:4] / 255
    up = np.asarray(Image.fromarray(pm.astype(np.uint8), "RGBA").resize((W, H), Image.LANCZOS)).astype(np.float32)
    a = up[..., 3:4]
    rgb = np.where(a > 0.5, up[..., :3] * 255 / np.maximum(a, 1), 0)
    alpha = up[..., 3] / 255
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    L = (0.3 * r + 0.59 * g + 0.11 * b) / 255
    Ln = np.clip((L - L_LO) / (L_HI - L_LO), 0, 1)
    # eye masks at base res -> scaled
    barr = arr
    bgr = barr[..., 1] - np.maximum(barr[..., 0], barr[..., 2])
    eye_masks = []
    for (x0, y0, x1, y1) in (EYE_L_BOX, EYE_R_BOX):
        sub = (barr[y0:y1, x0:x1, 3] > 200) & (bgr[y0:y1, x0:x1] < 12)
        sub = ndi.binary_fill_holes(ndi.binary_opening(sub, iterations=1))
        lab, n = ndi.label(sub)
        sz = ndi.sum(sub, lab, range(1, n + 1))
        m = np.zeros(barr.shape[:2], bool)
        m[y0:y1, x0:x1] = lab == (1 + int(np.argmax(sz)))
        mi = Image.fromarray((m * 255).astype(np.uint8)).resize((W, H), Image.BILINEAR)
        mf = np.asarray(mi).astype(np.float32) / 255
        eye_masks.append(mf)
    # recolour weight: whole silhouette except eyes and the near-black nose/mouth features
    eyes_any = np.maximum(eye_masks[0], eye_masks[1])
    eyes_any = ndi.grey_dilation(eyes_any, size=(5, 5))
    mx = np.maximum(np.maximum(r, g), b); mn = np.minimum(np.minimum(r, g), b)
    darkfeat = np.clip((70 - mx) / 25, 0, 1) * np.clip((30 - (mx - mn)) / 15, 0, 1)
    darkfeat = ndi.gaussian_filter(darkfeat, 1.0)
    w = (alpha > 0.01) * (1 - eyes_any) * (1 - darkfeat)
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    return dict(rgb=rgb, alpha=alpha, w=w, Ln=Ln, eyes=eye_masks, W=W, H=H, xx=xx / W, yy=yy / H)


# =============================== FUR RECOLOUR ===============================
FUR_MAPS = {
    "Mint Vinyl": [(0, (30, 105, 92)), (0.5, (118, 214, 186)), (1, (228, 255, 246))],
    "Forest Vinyl": [(0, (8, 42, 20)), (0.5, (38, 112, 58)), (1, (150, 205, 150))],
    "Chartreuse": [(0, (70, 100, 0)), (0.5, (186, 232, 28)), (1, (248, 255, 196))],
    "Olive Glow": [(0, (52, 56, 12)), (0.5, (146, 152, 52)), (1, (232, 234, 176))],
    "Neon Cream": [(0, (120, 108, 70)), (0.5, (236, 224, 172)), (1, (255, 255, 242))],
    "Sky Vinyl": [(0, (20, 62, 128)), (0.5, (92, 168, 236)), (1, (222, 242, 255))],
    "Bubblegum": [(0, (128, 36, 84)), (0.5, (242, 128, 186)), (1, (255, 228, 242))],
    "Midnight": [(0, (8, 8, 26)), (0.5, (40, 46, 96)), (1, (156, 166, 226))],
    "Gold": [(0, (66, 36, 4)), (0.3, (160, 100, 18)), (0.6, (238, 186, 56)), (0.82, (255, 224, 120)), (1, (255, 250, 224))],
    "Chrome": [(0, (22, 25, 32)), (0.3, (98, 106, 120)), (0.55, (206, 212, 222)), (0.72, (128, 136, 150)), (1, (255, 255, 255))],
    "Glow-in-the-Dark": [(0, (70, 150, 96)), (0.5, (176, 255, 168)), (1, (244, 255, 236))],
    "Galaxy": [(0, (10, 6, 34)), (0.5, (64, 32, 136)), (1, (196, 156, 255))],
}
SOL_A = [(0, (48, 8, 98)), (0.5, (153, 69, 255)), (1, (228, 204, 255))]
SOL_B = [(0, (4, 78, 58)), (0.5, (20, 241, 149)), (1, (212, 255, 236))]


def recolour(A, fur, rng):
    rgb, w, Ln, xx, yy = A["rgb"], A["w"], A["Ln"], A["xx"], A["yy"]
    if fur == "Lime Vinyl":
        return rgb.copy()
    if fur in ("Gold", "Chrome"):
        t = np.clip(Ln + 0.10 * np.sin(Ln * 13 + yy * 6), 0, 1)
        new = gmap(t, FUR_MAPS[fur])
    elif fur == "Sol Gradient":
        d = np.clip(xx * 0.45 + yy * 0.75 - 0.1, 0, 1)[..., None]
        new = gmap(Ln, SOL_A) * (1 - d) + gmap(Ln, SOL_B) * d
    elif fur == "Holographic":
        hue = ((xx * 0.9 + yy * 0.6 + Ln * 0.8) % 1.0)
        # vectorised HSV->RGB
        s = 0.42 * np.ones_like(hue)
        v = 0.62 + 0.38 * Ln
        i = np.floor(hue * 6).astype(int) % 6
        f = hue * 6 - np.floor(hue * 6)
        p, q, tt = v * (1 - s), v * (1 - f * s), v * (1 - (1 - f) * s)
        r = np.choose(i, [v, q, p, p, tt, v]); g = np.choose(i, [tt, v, v, q, p, p]); b = np.choose(i, [p, p, tt, v, v, q])
        new = np.stack([r, g, b], -1) * 255
    elif fur == "Galaxy":
        new = gmap(Ln, FUR_MAPS["Galaxy"])
        neb = 0.5 + 0.5 * np.sin(xx * 9 + np.cos(yy * 7) * 2)
        new[..., 0] += neb * 40 * Ln; new[..., 2] += (1 - neb) * 30
        H, W = Ln.shape
        n = 260
        sx = [int(rng.random() * W) for _ in range(n)]; sy = [int(rng.random() * H) for _ in range(n)]
        for x, y in zip(sx, sy):
            rr = 1 + int(rng.random() * 3)
            new[max(0, y - rr):y + rr, max(0, x - rr):x + rr] = 255
    else:
        new = gmap(Ln, FUR_MAPS[fur])
    w3 = w[..., None]
    return rgb * (1 - w3) + new * w3


# =============================== EYES ===============================
def eye_geom(A, i):
    m = A["eyes"][i]
    ys, xs = np.where(m > 0.5)
    return dict(x0=xs.min(), x1=xs.max(), y0=ys.min(), y1=ys.max(), cx=(xs.min() + xs.max()) / 2, cy=(ys.min() + ys.max()) / 2)


def paint_eye_whites(rgb, A, which=(0, 1)):
    for i in which:
        m = A["eyes"][i]
        g = eye_geom(A, i)
        hgt = g["y1"] - g["y0"]
        t = np.clip((A["yy"] * A["H"] - g["y0"]) / max(hgt, 1), 0, 1)
        white = gmap(t, [(0, (196, 202, 198)), (0.35, (246, 247, 245)), (0.8, (238, 240, 238)), (1, (205, 210, 206))])
        # ambient occlusion near the rim
        dist = ndi.distance_transform_edt(m > 0.5)
        ao = np.clip(dist / U(9), 0, 1)[..., None]
        white = white * (0.78 + 0.22 * ao)
        mm = m[..., None]
        rgb[:] = rgb * (1 - mm) + white * mm


def lid_mask(A, i, frac, curve=0.12):
    g = eye_geom(A, i)
    H, W = A["H"], A["W"]
    xx, yy = A["xx"] * W, A["yy"] * H
    span = g["x1"] - g["x0"]
    u = (xx - g["cx"]) / (span / 2)
    edge = g["y0"] + frac * (g["y1"] - g["y0"]) + curve * (g["y1"] - g["y0"]) * (1 - np.clip(u, -1, 1) ** 2)
    soft = np.clip((edge - yy) / 2.5 + 0.5, 0, 1)
    return soft * A["eyes"][i], edge


def paint_lid(rgb, A, i, frac, curve=0.12):
    lm, edge = lid_mask(A, i, frac, curve)
    g = eye_geom(A, i)
    t = np.clip((A["yy"] * A["H"] - g["y0"]) / max(g["y1"] - g["y0"], 1), 0, 1)
    lid = gmap(t, [(0, (62, 120, 60)), (0.6, (100, 176, 96)), (1, (120, 192, 112))])
    m = lm[..., None]
    rgb[:] = rgb * (1 - m) + lid * m
    # lid line
    yy = A["yy"] * A["H"]
    line = np.clip(1 - np.abs(yy - edge) / U(2.4), 0, 1) * (ndi.binary_dilation(A["eyes"][i] > 0.5, iterations=2))
    l3 = line[..., None]
    rgb[:] = rgb * (1 - l3) + np.array([28, 52, 30], np.float32) * l3
    return lm


def draw_pupils(cat: Image.Image, A, style, lids):
    """cat: RGBA image (cat-local coords). Draw style pupils clipped to visible eye area."""
    W, H = A["W"], A["H"]
    for i in (0, 1):
        if style == "Wink" and i == 0:
            continue
        g = eye_geom(A, i)
        vis = A["eyes"][i] * (1 - lids[i])
        lay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        d = ImageDraw.Draw(lay)
        cx, cy = g["cx"], g["cy"] + U(2)
        r = U(33)
        if style in ("Side-Eye",):
            cx = g["x1"] - U(32); cy = g["cy"] + U(4); r = U(29)
        elif style == "Tiny Pupils":
            r = U(13)
        elif style == "Big Pupils":
            r = U(41)
        elif style == "Sleepy":
            cy = g["cy"] + U(16); r = U(30)
        elif style == "Wink":
            cx = (PUPIL_R[0]) * K; cy = PUPIL_R[1] * K
        if style in ("Side-Eye", "Tiny Pupils", "Big Pupils", "Sleepy", "Wink"):
            d.ellipse([cx - r, cy - r * 1.04, cx + r, cy + r * 1.04], fill=(14, 14, 18, 255))
            d.ellipse([cx - r * .72, cy - r * .74, cx + r * .62, cy + r * .6], fill=(32, 32, 40, 255))
            hr = max(U(5), r * 0.26)
            d.ellipse([cx - r * .45 - hr, cy - r * .45 - hr, cx - r * .45 + hr, cy - r * .45 + hr], fill=(255, 255, 255, 245))
            if style == "Big Pupils":
                d.ellipse([cx + r * .3 - hr * .5, cy + r * .3 - hr * .5, cx + r * .3 + hr * .5, cy + r * .3 + hr * .5], fill=(255, 255, 255, 230))
        elif style == "Heart Eyes":
            heart(d, cx, cy + U(2), U(36), (232, 40, 92, 255))
            heart(d, cx - U(8), cy - U(6), U(9), (255, 190, 210, 255))
        elif style == "Dizzy":
            pts = []
            for k in range(220):
                th = k / 220 * 4.2 * math.pi
                rr = U(3) + U(34) * k / 220
                pts.append((cx + rr * math.cos(th), cy + rr * math.sin(th)))
            d.line(pts, fill=(18, 18, 22, 255), width=int(U(5)), joint="curve")
        elif style == "Star Eyes":
            star(d, cx, cy, U(38), U(16), (255, 206, 40, 255), n=5)
            star(d, cx, cy, U(22), U(9), (255, 244, 170, 255), n=5)
        elif style == "Glow Eyes":
            d.ellipse([g["x0"] - 4, g["y0"] - 4, g["x1"] + 4, g["y1"] + 4], fill=(30, 255, 230, 255))
            d.ellipse([cx - U(26), cy - U(20), cx + U(26), cy + U(24)], fill=(210, 255, 250, 255))
            d.ellipse([cx - U(12), cy - U(8), cx + U(12), cy + U(12)], fill=(255, 255, 255, 255))
        elif style == "Laser Eyes":
            d.ellipse([g["x0"] - 4, g["y0"] - 4, g["x1"] + 4, g["y1"] + 4], fill=(255, 40, 30, 255))
            d.ellipse([cx - U(30), cy - U(24), cx + U(30), cy + U(26)], fill=(255, 150, 120, 255))
            d.ellipse([cx - U(15), cy - U(11), cx + U(15), cy + U(13)], fill=(255, 255, 240, 255))
        a = np.asarray(lay.getchannel("A")).astype(np.float32) * vis
        lay.putalpha(Image.fromarray(np.clip(a, 0, 255).astype(np.uint8)))
        cat.alpha_composite(lay)
        if style == "Glow Eyes" or style == "Laser Eyes":
            col = (40, 255, 220, 200) if style == "Glow Eyes" else (255, 50, 30, 220)
            gl = Image.new("RGBA", (W, H), (0, 0, 0, 0))
            ImageDraw.Draw(gl).ellipse([g["x0"], g["y0"], g["x1"], g["y1"]], fill=col)
            gl = gl.filter(ImageFilter.GaussianBlur(U(14)))
            ga = np.asarray(gl.getchannel("A")).astype(np.float32) * (A["alpha"] > 0.5) * 0.85
            gl.putalpha(Image.fromarray(ga.astype(np.uint8)))
            cat.alpha_composite(gl)
    if style == "Wink":
        g = eye_geom(A, 0)
        d = ImageDraw.Draw(cat)
        cy = g["cy"] + U(6)
        d.arc([g["x0"] + U(10), cy - U(26), g["x1"] - U(6), cy + U(16)], 25, 160, fill=(26, 46, 28, 255), width=int(U(5)))


def heart(d, cx, cy, r, col):
    pts = []
    for k in range(120):
        t = k / 120 * 2 * math.pi
        x = 16 * math.sin(t) ** 3
        y = 13 * math.cos(t) - 5 * math.cos(2 * t) - 2 * math.cos(3 * t) - math.cos(4 * t)
        pts.append((cx + x / 16 * r, cy - y / 16 * r))
    d.polygon(pts, fill=col)


def star(d, cx, cy, ro, ri, col, n=5, rot=-90):
    pts = []
    for k in range(n * 2):
        rr = ro if k % 2 == 0 else ri
        th = math.radians(rot + k * 180 / n)
        pts.append((cx + rr * math.cos(th), cy + rr * math.sin(th)))
    d.polygon(pts, fill=col)


def sparkle(d, cx, cy, r, col):
    d.polygon([(cx, cy - r), (cx + r * .22, cy - r * .22), (cx + r, cy), (cx + r * .22, cy + r * .22),
               (cx, cy + r), (cx - r * .22, cy + r * .22), (cx - r, cy), (cx - r * .22, cy - r * .22)], fill=col)


def build_cat(traits, rng):
    A = cat_assets()
    rgb = A["rgb"].copy()
    eyes = traits["Eyes"]
    lids = [np.zeros_like(A["alpha"]), np.zeros_like(A["alpha"])]
    if eyes != "Grumpy":
        paint_eye_whites(rgb, A)
        if eyes == "Sleepy":
            lids = [paint_lid(rgb, A, 0, 0.42), paint_lid(rgb, A, 1, 0.42)]
        if eyes == "Wink":
            lids[0] = paint_lid(rgb, A, 0, 1.05, curve=0.0)
    A2 = dict(A); A2["rgb"] = rgb
    new = recolour(A2, traits["Fur"], rng)
    img = Image.fromarray(np.dstack([np.clip(new, 0, 255), A["alpha"] * 255]).astype(np.uint8), "RGBA")
    if eyes != "Grumpy":
        draw_pupils(img, A, eyes, lids)
    return img


# =============================== BACKGROUNDS ===============================
FLATS = {"Concrete Grey": ("#dcdcdc", "#c2c2c4"), "Mint Flat": ("#d9f7e6", "#b8ead0"), "Cream Flat": ("#fbf3df", "#efe0bd"),
         "Sky Flat": ("#d8ecfb", "#b3d6f2"), "Peach Flat": ("#ffe1cf", "#f8c3a6"), "Lavender Flat": ("#e9e1fb", "#cfc0f2"),
         "Sage Flat": ("#e1ead6", "#c3d3b3"), "Butter Flat": ("#fff3b8", "#f5df7c"), "Coral Flat": ("#ffd0c8", "#f7a597"),
         "Seafoam Flat": ("#ccf3ef", "#9fe2da"), "Slate Flat": ("#c9d1db", "#a5b0be")}


def rgb_t(h):
    return hexc(h)[:3]


def background(name, rng) -> Image.Image:
    if name in FLATS:
        a, b = FLATS[name]
        r = radial(S, S, S / 2, S * 0.42, S * 0.85)[..., None]
        arr = np.array(rgb_t(a), np.float32) * (1 - r) + np.array(rgb_t(b), np.float32) * r
        return to_img(arr)
    fn = BG_FUNCS[name]
    return fn(rng)


def bg_deep_forest(rng):
    r = radial(S, S, S / 2, S * .45, S * .8)
    img = to_img(gmap(r, [(0, (54, 116, 64)), (0.6, (22, 62, 32)), (1, (8, 26, 14))]))
    lay = new_layer(); d = ImageDraw.Draw(lay)
    for _ in range(26):
        x, y, rr = rng.random() * S, rng.random() * S, 30 + rng.random() * 110
        c = (150 + int(rng.random() * 80), 230, 120, int(25 + rng.random() * 45))
        d.ellipse([x - rr, y - rr, x + rr, y + rr], fill=c)
    img.alpha_composite(fast_blur(lay, 10))
    return img


def bg_vinyl_void(rng):
    r = radial(S, S, S / 2, S * .4, S * .75)
    img = to_img(gmap(r, [(0, (58, 58, 66)), (0.7, (22, 22, 26)), (1, (8, 8, 10))]))
    lay = new_layer(); d = ImageDraw.Draw(lay)
    d.ellipse([S * .12, S * .80, S * .88, S * 1.06], fill=(120, 120, 135, 70))
    img.alpha_composite(fast_blur(lay, 40))
    return img


def bg_halftone(rng):
    img = to_img(lin_grad(S, S, [(0, (22, 70, 40)), (1, (10, 40, 22))]))
    d = ImageDraw.Draw(img)
    step = 64
    for y in range(0, S + step, step):
        for x in range(0, S + step, step):
            ox = step / 2 if (y // step) % 2 else 0
            dist = math.hypot((x + ox) / S - .5, y / S - .45)
            rr = 6 + 20 * min(1, dist * 1.6)
            d.ellipse([x + ox - rr, y - rr, x + ox + rr, y + rr], fill=(170, 236, 40, 255))
    return img


def bg_pixel_meadow(rng):
    n = 64
    sky = lin_grad(n, n, [(0, (90, 170, 255)), (0.65, (180, 225, 255)), (1, (180, 225, 255))])
    img = Image.fromarray(sky.astype(np.uint8)).convert("RGBA")
    d = ImageDraw.Draw(img)
    for cx, cy in [(10 + int(rng.random() * 8), 8), (40 + int(rng.random() * 10), 14)]:
        for dx, dy, w in [(0, 0, 10), (2, -2, 6), (-2, 1, 4)]:
            d.rectangle([cx + dx, cy + dy, cx + dx + w, cy + dy + 2], fill=(255, 255, 255, 255))
    for x in range(n):
        h = int(44 + 3 * math.sin(x / 6 + rng.random() * 0.2) + 2 * math.sin(x / 2.7))
        d.line([(x, h), (x, n)], fill=(88, 186, 70, 255))
        d.point((x, h), fill=(140, 220, 90, 255))
        if (x * 7) % 11 == 0:
            d.point((x, h + 6), fill=(255, 220, 60, 255))
    return img.resize((S, S), Image.NEAREST)


def bg_neon_alley(rng):
    img = to_img(lin_grad(S, S, [(0, (12, 6, 34)), (0.55, (58, 14, 92)), (0.62, (255, 60, 190)), (0.63, (24, 8, 46)), (1, (8, 4, 20))]))
    lay = new_layer(); d = ImageDraw.Draw(lay)
    hz = S * 0.62
    for k in range(-14, 15):
        d.line([(S / 2 + k * 40, hz), (S / 2 + k * 380, S)], fill=(0, 240, 255, 200), width=5)
    y = hz; step = 18
    while y < S:
        d.line([(0, y), (S, y)], fill=(255, 60, 200, 200), width=5)
        step *= 1.32; y += step
    for k in range(14):
        x = rng.random() * S; w = 30 + rng.random() * 90; h = 200 + rng.random() * 500
        d.rectangle([x, hz - h, x + w, hz], fill=(30, 10, 60, 255))
        for j in range(int(h // 50)):
            if rng.random() < .5:
                d.rectangle([x + 8, hz - h + j * 50 + 10, x + w - 8, hz - h + j * 50 + 24], fill=(255, 80, 200, 160) if rng.random() < .5 else (0, 230, 255, 160))
    add_glow(img, lay, 10, 1.0, 1)
    return img


def bg_sol_dusk(rng):
    img = to_img(lin_grad(S, S, [(0, (26, 8, 60)), (0.45, (110, 40, 200)), (0.75, (40, 170, 170)), (1, (12, 60, 70))]))
    lay = new_layer(); d = ImageDraw.Draw(lay)
    cx, cy, r = S / 2, S * .44, S * .30
    sun = Image.new("L", (S, S), 0); ImageDraw.Draw(sun).ellipse([cx - r, cy - r, cx + r, cy + r], fill=255)
    sg = to_img(lin_grad(S, S, [(0, (20, 241, 149)), (0.35, (20, 241, 149)), (0.6, (153, 69, 255)), (1, (153, 69, 255))]))
    sa = np.asarray(sun).astype(np.float32)
    yy = np.arange(S)[:, None]
    stripes = ((yy > cy) & (((yy - cy) % 70) < (8 + (yy - cy) / 14))).astype(np.float32)
    sa = sa * (1 - stripes)
    sg.putalpha(Image.fromarray(sa.astype(np.uint8)))
    add_glow(img, sg, 50, 0.9, 1)
    return img


def bg_lime_nebula(rng):
    img = to_img(lin_grad(S, S, [(0, (6, 8, 22)), (1, (10, 18, 30))]))
    lay = new_layer(); d = ImageDraw.Draw(lay)
    cols = [(184, 255, 0), (20, 220, 200), (150, 60, 255), (80, 255, 140)]
    for _ in range(14):
        x, y, rr = rng.random() * S, rng.random() * S, 200 + rng.random() * 400
        c = cols[int(rng.random() * len(cols))]
        d.ellipse([x - rr, y - rr, x + rr, y + rr], fill=c + (int(30 + rng.random() * 40),))
    img.alpha_composite(fast_blur(lay, 120))
    d = ImageDraw.Draw(img)
    for _ in range(500):
        x, y = rng.random() * S, rng.random() * S; rr = rng.random() * 3.5 + .5
        d.ellipse([x - rr, y - rr, x + rr, y + rr], fill=(255, 255, 255, int(120 + rng.random() * 135)))
    for _ in range(6):
        sparkle(d, rng.random() * S, rng.random() * S, 18 + rng.random() * 18, (255, 255, 230, 230))
    return img


def bg_chart_green(rng):
    img = to_img(lin_grad(S, S, [(0, (8, 22, 16)), (1, (4, 10, 8))]))
    d = ImageDraw.Draw(img)
    for x in range(0, S, 128):
        d.line([(x, 0), (x, S)], fill=(30, 60, 40, 255), width=2)
    for y in range(0, S, 128):
        d.line([(0, y), (S, y)], fill=(30, 60, 40, 255), width=2)
    lay = new_layer(); dl = ImageDraw.Draw(lay)
    price = S * 0.82; xs = []
    for k in range(26):
        x = 60 + k * 76
        o = price; c = o - (rng.random() * 140 - 35)
        hi, lo = min(o, c) - rng.random() * 50, max(o, c) + rng.random() * 50
        up = c < o
        col = (46, 255, 120, 255) if up else (255, 70, 90, 255)
        dl.line([(x, hi), (x, lo)], fill=col, width=5)
        dl.rectangle([x - 20, min(o, c), x + 20, max(o, c) + 4], fill=col)
        price = c; xs.append((x, c))
    dl.line(xs, fill=(184, 255, 0, 230), width=8, joint="curve")
    add_glow(img, lay, 16, 0.8, 1)
    return img


def bg_lofi_night(rng):
    img = to_img(lin_grad(S, S, [(0, (52, 34, 70)), (1, (30, 20, 44))]))
    d = ImageDraw.Draw(img)
    wx0, wy0, wx1, wy1 = S * .1, S * .08, S * .9, S * .7
    win = to_img(lin_grad(int(wx1 - wx0), int(wy1 - wy0), [(0, (18, 24, 70)), (1, (90, 60, 130))]))
    wd = ImageDraw.Draw(win)
    ww, wh = win.size
    wd.ellipse([ww * .72, wh * .1, ww * .88, wh * .1 + ww * .16], fill=(255, 244, 214, 255))
    x = 0
    while x < ww:
        bw = 60 + rng.random() * 140; bh = wh * (.25 + rng.random() * .45)
        wd.rectangle([x, wh - bh, x + bw, wh], fill=(22, 16, 40, 255))
        for yy in range(int(wh - bh + 20), int(wh), 34):
            for xx in range(int(x + 12), int(x + bw - 12), 26):
                if rng.random() < .35:
                    wd.rectangle([xx, yy, xx + 12, yy + 16], fill=(255, 210, 120, 255))
        x += bw + 6
    for _ in range(160):
        rx, ry = rng.random() * ww, rng.random() * wh
        wd.line([(rx, ry), (rx - 10, ry + 46)], fill=(180, 200, 255, 90), width=2)
    img.alpha_composite(win, (int(wx0), int(wy0)))
    fr = (70, 48, 40, 255)
    d.rectangle([wx0 - 30, wy0 - 30, wx1 + 30, wy1 + 30], outline=fr, width=34)
    d.line([((wx0 + wx1) / 2, wy0), ((wx0 + wx1) / 2, wy1)], fill=fr, width=26)
    d.line([(wx0, (wy0 + wy1) / 2), (wx1, (wy0 + wy1) / 2)], fill=fr, width=26)
    d.rectangle([wx0 - 80, wy1 + 20, wx1 + 80, wy1 + 70], fill=(96, 66, 52, 255))
    # warm lamp glow
    lay = new_layer(); ImageDraw.Draw(lay).ellipse([-S * .3, S * .5, S * .5, S * 1.3], fill=(255, 160, 80, 70))
    img.alpha_composite(fast_blur(lay, 120))
    return img


def bg_laser_loft(rng):
    img = to_img(radial(S, S, S / 2, S * .5, S * .8)[..., None] * np.array([-30, -30, -20], np.float32) + np.array([30, 20, 44], np.float32))
    lay = new_layer(); d = ImageDraw.Draw(lay)
    cols = [(255, 40, 80), (0, 240, 255), (184, 255, 0), (255, 60, 220)]
    for k in range(18):
        src = (0, 0) if k % 2 else (S, 0)
        ang = math.radians(20 + rng.random() * 50) if k % 2 else math.radians(110 + rng.random() * 50)
        end = (src[0] + math.cos(ang) * S * 2, src[1] + math.sin(ang) * S * 2)
        d.line([src, end], fill=cols[k % 4] + (220,), width=7)
    add_glow(img, lay, 18, 1.0, 2)
    haze = new_layer(); ImageDraw.Draw(haze).rectangle([0, S * .7, S, S], fill=(255, 120, 220, 50))
    img.alpha_composite(fast_blur(haze, 100))
    return img


def bg_holo_foil(rng):
    yy, xx = np.mgrid[0:S, 0:S].astype(np.float32)
    ang = np.arctan2(yy - S / 2, xx - S / 2) / (2 * math.pi) + 0.5
    rr = np.sqrt((xx - S / 2) ** 2 + (yy - S / 2) ** 2) / S
    hue = (ang * 2 + rr * 1.5 + 0.08 * np.sin(xx / 90 + yy / 140)) % 1
    s, v = 0.38, 0.98
    i = np.floor(hue * 6).astype(int) % 6; f = hue * 6 - np.floor(hue * 6)
    p, q, t = v * (1 - s), v * (1 - f * s), v * (1 - (1 - f) * s)
    v_ = np.full_like(hue, v); p_ = np.full_like(hue, p)
    r = np.choose(i, [v_, q, p_, p_, t, v_]); g = np.choose(i, [t, v_, v_, q, p_, p_]); b = np.choose(i, [p_, p_, t, v_, v_, q])
    arr = np.stack([r, g, b], -1) * 255
    streak = (0.5 + 0.5 * np.sin((xx + yy) / 60)) ** 8 * 40
    img = to_img(arr + streak[..., None])
    d = ImageDraw.Draw(img)
    for _ in range(30):
        sparkle(d, rng.random() * S, rng.random() * S, 12 + rng.random() * 26, (255, 255, 255, 220))
    return img


def bg_golden_vault(rng):
    yy, xx = np.mgrid[0:S, 0:S].astype(np.float32)
    ang = np.arctan2(yy - S * .42, xx - S / 2)
    rays = (np.sin(ang * 16) > 0).astype(np.float32)
    r = radial(S, S, S / 2, S * .42, S * .9)
    base = gmap(r, [(0, (255, 226, 120)), (0.5, (214, 150, 30)), (1, (90, 50, 6))])
    arr = base * (0.86 + 0.14 * rays[..., None])
    img = to_img(arr)
    d = ImageDraw.Draw(img)
    for _ in range(26):
        sparkle(d, rng.random() * S, rng.random() * S, 10 + rng.random() * 24, (255, 252, 230, 230))
    return img


def bg_moonlit(rng):
    img = to_img(lin_grad(S, S, [(0, (8, 12, 40)), (0.7, (30, 48, 110)), (1, (40, 60, 120))]))
    d = ImageDraw.Draw(img)
    for _ in range(300):
        x, y = rng.random() * S, rng.random() * S * .7; rr = rng.random() * 3 + .5
        d.ellipse([x - rr, y - rr, x + rr, y + rr], fill=(255, 255, 255, int(100 + rng.random() * 155)))
    moon = new_layer(); md = ImageDraw.Draw(moon)
    cx, cy, r = S / 2, S * .36, S * .33
    md.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(255, 246, 214, 255))
    for _ in range(9):
        a, b, rr = cx + (rng.random() - .5) * r * 1.3, cy + (rng.random() - .5) * r * 1.3, 20 + rng.random() * 60
        md.ellipse([a - rr, b - rr, a + rr, b + rr], fill=(236, 224, 190, 255))
    add_glow(img, moon, 60, 0.8, 1)
    d = ImageDraw.Draw(img)
    roof = [(0, S * .86), (S * .25, S * .80), (S * .5, S * .84), (S * .75, S * .79), (S, S * .85), (S, S), (0, S)]
    d.polygon(roof, fill=(10, 12, 26, 255))
    d.rectangle([S * .12, S * .72, S * .18, S * .83], fill=(10, 12, 26, 255))
    d.rectangle([S * .8, S * .70, S * .87, S * .80], fill=(10, 12, 26, 255))
    return img


BG_FUNCS = {"Deep Forest": bg_deep_forest, "Vinyl Void": bg_vinyl_void, "Halftone Lime": bg_halftone,
            "Pixel Meadow": bg_pixel_meadow, "Neon Alley": bg_neon_alley, "Sol Dusk": bg_sol_dusk,
            "Lime Nebula": bg_lime_nebula, "Chart Green": bg_chart_green, "Lo-fi Night": bg_lofi_night,
            "Laser Loft": bg_laser_loft, "Holo Foil": bg_holo_foil, "Golden Vault": bg_golden_vault,
            "Moonlit Rooftop": bg_moonlit}
DARK_BGS = {"Halftone Lime", "Deep Forest", "Vinyl Void", "Neon Alley", "Lime Nebula", "Chart Green", "Lo-fi Night", "Laser Loft", "Moonlit Rooftop", "Sol Dusk"}


# =============================== EYEWEAR ===============================
def eyewear(canvas, name, eyes):
    if name == "None":
        return
    lay = new_layer(); d = ImageDraw.Draw(lay)
    Lc, Rc = P(*EYE_L_C), P(*EYE_R_C)
    rw, rh = U(66), U(56)
    def lens_box(c, sx=1.0, sy=1.0, dy=0):
        return [c[0] - rw * sx, c[1] - rh * sy + U(dy), c[0] + rw * sx, c[1] + rh * sy + U(dy)]
    temple_y = P(0, 262)[1]
    if name == "Round Specs":
        for c in (Lc, Rc):
            d.ellipse(lens_box(c, .92, 1.0), fill=(200, 230, 255, 40), outline=(40, 30, 24, 255), width=int(U(7)))
        bl = (Lc[0] + rw * .92, Lc[1] - U(8)); br = (Rc[0] - rw * .92, Rc[1] - U(8))
        mid = ((bl[0] + br[0]) / 2, bl[1] - U(12))
        d.line([bl, mid, br], fill=(40, 30, 24, 255), width=int(U(7)), joint="curve")
        d.line([(Lc[0] - rw * .92, temple_y), (P(20, 0)[0], temple_y - U(6))], fill=(40, 30, 24, 255), width=int(U(7)))
        d.line([(Rc[0] + rw * .92, temple_y), (P(548, 0)[0], temple_y - U(6))], fill=(40, 30, 24, 255), width=int(U(7)))
    elif name in ("Cool Shades", "Gold Aviators"):
        gold = name == "Gold Aviators"
        frame = (214, 160, 40, 255) if gold else (14, 14, 16, 255)
        for c, flip in ((Lc, -1), (Rc, 1)):
            x0, y0, x1, y1 = lens_box(c, 1.08, 0.92, -4)
            if gold:
                pts = [(x0, y0 + U(6)), (x1, y0), (x1 - U(8), y1 - U(30)), ((x0 + x1) / 2, y1), (x0 + U(10), y1 - U(18))]
                if flip < 0:
                    pts = [(x0 + x1 - x, y) for x, y in pts]
                lens = Image.new("RGBA", (S, S), (0, 0, 0, 0)); ld = ImageDraw.Draw(lens)
                ld.polygon(pts, fill=(255, 255, 255, 255))
                grad = to_img(lin_grad(S, S, [(0, (40, 20, 10)), (0.5, (60, 30, 10)), (1, (200, 120, 30))]))
                grad.putalpha(Image.fromarray((np.asarray(lens.getchannel("A")) * 0.94).astype(np.uint8)))
                lay.alpha_composite(grad)
                d.line(pts + [pts[0]], fill=frame, width=int(U(8)), joint="curve")
            else:
                d.rounded_rectangle([x0, y0, x1, y1], radius=U(26), fill=(16, 16, 20, 250), outline=frame, width=int(U(6)))
            d.line([(x0 + U(18), y0 + U(18)), (x0 + U(48), y0 + U(10))], fill=(255, 255, 255, 170), width=int(U(7)))
        d.line([(Lc[0] + rw * .9, Lc[1] - U(30)), (Rc[0] - rw * .9, Rc[1] - U(30))], fill=frame, width=int(U(10)))
        d.line([(Lc[0] - rw * 1.08, Lc[1] - U(30)), (P(18, 0)[0], Lc[1] - U(36))], fill=frame, width=int(U(9)))
        d.line([(Rc[0] + rw * 1.08, Rc[1] - U(30)), (P(548, 0)[0], Rc[1] - U(36))], fill=frame, width=int(U(9)))
    elif name == "3D Glasses":
        x0 = Lc[0] - rw * 1.05; x1 = Rc[0] + rw * 1.05
        y0 = Lc[1] - rh * .85; y1 = Lc[1] + rh * .85
        d.rounded_rectangle([x0, y0, x1, y1], radius=U(10), fill=(250, 250, 250, 255))
        d.rounded_rectangle(lens_box(Lc, .88, .7), radius=U(8), fill=(235, 30, 50, 170))
        d.rounded_rectangle(lens_box(Rc, .88, .7), radius=U(8), fill=(30, 200, 240, 170))
        d.line([(x0, y0 + U(10)), (P(18, 0)[0], y0)], fill=(250, 250, 250, 255), width=int(U(8)))
        d.line([(x1, y0 + U(10)), (P(548, 0)[0], y0)], fill=(250, 250, 250, 255), width=int(U(8)))
    elif name == "Monocle":
        bx = lens_box(Rc, .95, 1.08)
        d.ellipse(bx, fill=(220, 240, 255, 45), outline=(214, 166, 50, 255), width=int(U(8)))
        cx, cy = (bx[0] + bx[2]) / 2, bx[3]
        pts = [(cx + U(30), cy - U(10))]
        for k in range(1, 18):
            pts.append((cx + U(34) + U(6) * math.sin(k), cy + k * U(13)))
        for p in pts:
            d.ellipse([p[0] - U(4), p[1] - U(4), p[0] + U(4), p[1] + U(4)], outline=(214, 166, 50, 255), width=int(U(2.5)))
    elif name == "Pixel Shades":
        px = U(15)
        ox, oy = P(92, 238)
        rows = ["11111111111111111111111111",
                "01222222111110122222211110",
                "01222211111110122221111100",
                "00122111111100012211111000",
                "00011111110000001111110000"]
        for j, row in enumerate(rows):
            for i, ch in enumerate(row):
                if ch != "0":
                    col = (12, 12, 12, 255) if ch == "1" else (255, 255, 255, 255)
                    d.rectangle([ox + i * px, oy + j * px, ox + (i + 1) * px, oy + (j + 1) * px], fill=col)
    elif name == "Neon Visor":
        x0 = P(40, 0)[0]; x1 = P(525, 0)[0]
        y0 = Lc[1] - rh * .95; y1 = Lc[1] + rh * .8
        grad = to_img(lin_grad(S, S, [(0, (255, 40, 200)), (1, (0, 230, 255))], axis="x"))
        m = Image.new("L", (S, S), 0); ImageDraw.Draw(m).rounded_rectangle([x0, y0, x1, y1], radius=U(40), fill=225)
        grad.putalpha(m)
        glow = new_layer(); ImageDraw.Draw(glow).rounded_rectangle([x0, y0, x1, y1], radius=U(40), outline=(255, 255, 255, 255), width=int(U(6)))
        lay.alpha_composite(grad); add_glow(lay, glow, 10, 1, 1)
        d = ImageDraw.Draw(lay)
        d.line([(x0 + U(40), y0 + U(18)), (x1 - U(120), y0 + U(18))], fill=(255, 255, 255, 160), width=int(U(6)))
    if name not in ("Neon Visor",):
        lay = vinylize(lay, 0.4, 4.0)
    shadow = fast_blur(Image.merge("RGBA", (*[Image.new("L", (S, S), 0)] * 3, lay.getchannel("A").point(lambda v: v * 0.35))), 8)
    canvas.alpha_composite(shadow, (0, int(U(6))))
    canvas.alpha_composite(lay)


# =============================== HATS ===============================
def hat(canvas, name, rng):
    if name == "None":
        return
    lay = new_layer(); d = ImageDraw.Draw(lay)
    cx = P(290, 0)[0]
    def y(v): return P(0, v)[1]
    def x(v): return P(v, 0)[0]
    if name == "Beanie":
        col, dark = (226, 64, 64, 255), (176, 40, 44, 255)
        d.chord([x(118), y(-40), x(462), y(250)], 180, 360, fill=col)
        for k in range(8):
            xx = x(140 + k * 40)
            d.line([(xx, y(30)), (xx + U(6), y(104))], fill=dark, width=int(U(5)))
        d.rounded_rectangle([x(110), y(88), x(470), y(150)], radius=U(22), fill=dark)
        for k in range(11):
            xx = x(124 + k * 31)
            d.line([(xx, y(94)), (xx, y(144))], fill=(150, 30, 36, 255), width=int(U(4)))
        d.ellipse([cx - U(30), y(-70), cx + U(30), y(-12)], fill=(250, 240, 230, 255))
    elif name == "Backwards Cap":
        col = (40, 80, 200, 255)
        d.chord([x(130), y(0), x(450), y(220)], 180, 360, fill=col)
        d.rounded_rectangle([x(126), y(96), x(454), y(130)], radius=U(12), fill=(28, 60, 160, 255))
        d.chord([cx - U(46), y(66), cx + U(46), y(150)], 180, 360, fill=(200, 210, 230, 255))
        d.line([(cx - U(40), y(100)), (cx + U(40), y(100))], fill=(120, 130, 160, 255), width=int(U(6)))
        d.ellipse([cx - U(14), y(-8), cx + U(14), y(14)], fill=(28, 60, 160, 255))
        d.chord([x(200), y(-30), x(430), y(40)], 180, 360, fill=(28, 60, 160, 255))
    elif name == "Bandana":
        col = (210, 30, 50, 255)
        d.polygon([(x(50), y(150)), (x(290), y(120)), (x(520), y(150)), (x(522), y(196)), (x(290), y(166)), (x(46), y(196))], fill=col)
        for k in range(12):
            xx = x(70 + k * 38); yy = y(158 + (6 if k % 2 else 0)) - abs(k - 5.5) * U(2)
            d.ellipse([xx - U(5), yy - U(5), xx + U(5), yy + U(5)], fill=(255, 255, 255, 230))
        d.polygon([(x(515), y(160)), (x(580), y(210)), (x(560), y(240)), (x(510), y(190))], fill=(180, 22, 40, 255))
        d.polygon([(x(515), y(175)), (x(570), y(270)), (x(540), y(280)), (x(505), y(200))], fill=(196, 26, 46, 255))
    elif name == "Bucket Hat":
        col, dark = (236, 214, 160, 255), (196, 172, 120, 255)
        d.polygon([(x(90), y(130)), (x(170), y(80)), (x(410), y(80)), (x(490), y(130)), (x(400), y(112)), (x(180), y(112))], fill=dark)
        d.chord([x(160), y(-20), x(420), y(180)], 180, 360, fill=col)
        d.rectangle([x(160), y(68), x(420), y(84)], fill=(90, 120, 60, 255))
        d.polygon([(x(80), y(140)), (x(165), y(80)), (x(415), y(80)), (x(500), y(140)), (x(430), y(150)), (x(150), y(150))], fill=col)
        d.line([(x(84), y(140)), (x(150), y(150)), (x(430), y(150)), (x(496), y(140))], fill=dark, width=int(U(4)))
    elif name == "Headphones":
        band = (34, 34, 40, 255)
        d.arc([x(20), y(-30), x(560), y(560)], 188, 352, fill=band, width=int(U(26)))
        d.arc([x(36), y(-14), x(544), y(544)], 195, 345, fill=(184, 255, 0, 255), width=int(U(5)))
        for (a, b) in ((-14, 66), (500, 580)):
            d.rounded_rectangle([x(a), y(220), x(b), y(370)], radius=U(30), fill=(30, 30, 36, 255))
            d.rounded_rectangle([x(a + 10), y(232), x(b - 10), y(358)], radius=U(24), fill=(56, 56, 66, 255))
            d.ellipse([x((a + b) / 2 - 18), y(276), x((a + b) / 2 + 18), y(312)], fill=(184, 255, 0, 255))
    elif name == "Party Hat":
        tip = (x(330), y(-150)); bl, br = (x(200), y(80)), (x(400), y(70))
        d.polygon([tip, br, bl], fill=(255, 90, 170, 255))
        for k in range(1, 4):
            t = k / 4
            p1 = (tip[0] + (bl[0] - tip[0]) * t, tip[1] + (bl[1] - tip[1]) * t)
            p2 = (tip[0] + (br[0] - tip[0]) * t, tip[1] + (br[1] - tip[1]) * t)
            d.line([p1, p2], fill=(255, 230, 60, 255), width=int(U(14)))
        for k in range(9):
            xx = x(205 + k * 24)
            d.ellipse([xx - U(10), y(68) - U(10), xx + U(10), y(68) + U(10)], fill=(90, 220, 255, 255))
        d.ellipse([tip[0] - U(22), tip[1] - U(22), tip[0] + U(22), tip[1] + U(22)], fill=(255, 255, 255, 255))
    elif name == "Propeller Cap":
        cols = [(255, 64, 64, 255), (255, 210, 40, 255), (40, 160, 255, 255), (60, 200, 90, 255)]
        for k in range(4):
            d.pieslice([x(150), y(-20), x(430), y(220)], 180 + k * 45, 225 + k * 45, fill=cols[k])
        d.polygon([(x(150), y(100)), (x(430), y(100)), (x(470), y(118)), (x(110), y(118))], fill=(40, 160, 255, 255))
        d.line([(cx, y(-20)), (cx, y(-50))], fill=(80, 80, 90, 255), width=int(U(8)))
        d.ellipse([cx - U(90), y(-66), cx - U(4), y(-40)], fill=(255, 64, 64, 255))
        d.ellipse([cx + U(4), y(-60), cx + U(90), y(-34)], fill=(255, 210, 40, 255))
        d.ellipse([cx - U(9), y(-58), cx + U(9), y(-40)], fill=(60, 60, 70, 255))
    elif name == "Cowboy Hat":
        col, dark = (150, 96, 50, 255), (110, 68, 32, 255)
        d.chord([x(40), y(40), x(540), y(170)], 0, 180, fill=dark)
        d.polygon([(x(180), y(100)), (x(196), y(-10)), (x(230), y(-38)), (x(290), y(-18)), (x(350), y(-38)), (x(384), y(-10)), (x(400), y(100))], fill=col)
        d.line([(x(290), y(-14)), (x(290), y(40))], fill=dark, width=int(U(6)))
        d.rectangle([x(184), y(70), x(396), y(98)], fill=(60, 36, 20, 255))
        d.polygon([(x(30), y(70)), (x(160), y(110)), (x(420), y(110)), (x(550), y(70)), (x(500), y(130)), (x(290), y(140)), (x(80), y(130))], fill=col)
    elif name == "Wizard Hat":
        col = (76, 40, 160, 255)
        d.polygon([(x(160), y(110)), (x(300), y(-150)), (x(400), y(-125)), (x(335), y(-105)), (x(420), y(110))], fill=col)
        d.ellipse([x(90), y(80), x(490), y(150)], fill=(60, 30, 130, 255))
        for (a, b, r) in ((260, 10, 18), (335, 50, 12), (300, -60, 12), (230, 75, 10)):
            star(d, x(a), y(b), U(r), U(r * .45), (255, 220, 80, 255))
        d.ellipse([x(388), y(-140), x(418), y(-110)], fill=(255, 220, 80, 255))
    elif name == "Top Hat":
        d.rectangle([x(200), y(-140), x(380), y(90)], fill=(20, 20, 24, 255))
        d.ellipse([x(200), y(-160), x(380), y(-120)], fill=(40, 40, 48, 255))
        d.rectangle([x(200), y(40), x(380), y(80)], fill=(196, 30, 50, 255))
        d.ellipse([x(140), y(70), x(440), y(120)], fill=(20, 20, 24, 255))
        d.line([(x(214), y(-120)), (x(214), y(30))], fill=(70, 70, 80, 255), width=int(U(8)))
    elif name == "Crown":
        gold = to_img(lin_grad(S, S, [(0, (255, 236, 140)), (1, (196, 130, 20))]))
        m = Image.new("L", (S, S), 0); md = ImageDraw.Draw(m)
        pts = [(x(180), y(100)), (x(170), y(-30)), (x(222), y(30)), (x(250), y(-60)), (x(290), y(20)), (x(330), y(-60)),
               (x(358), y(30)), (x(410), y(-30)), (x(400), y(100))]
        md.polygon(pts, fill=255)
        gold.putalpha(m); lay.alpha_composite(gold); d = ImageDraw.Draw(lay)
        d.line(pts + [pts[0]], fill=(150, 96, 10, 255), width=int(U(4)))
        d.rectangle([x(180), y(70), x(400), y(100)], fill=(214, 150, 30, 255))
        for (a, c) in ((215, (230, 30, 60)), (290, (30, 140, 255)), (365, (40, 210, 120))):
            d.ellipse([x(a - 13), y(72), x(a + 13), y(98)], fill=c + (255,))
        for (a, b) in ((170, -30), (250, -60), (330, -60), (410, -30)):
            d.ellipse([x(a - 10), y(b - 10), x(a + 10), y(b + 10)], fill=(255, 250, 220, 255))
    elif name == "Halo":
        g = new_layer(); gd = ImageDraw.Draw(g)
        gd.ellipse([x(150), y(-110), x(430), y(-30)], outline=(255, 226, 100, 255), width=int(U(18)))
        gd.ellipse([x(162), y(-102), x(418), y(-38)], outline=(255, 250, 220, 255), width=int(U(5)))
        add_glow(lay, g, 22, 1.0, 2)
    if name != "Halo":
        lay = vinylize(lay)
    sh = Image.merge("RGBA", (*[Image.new("L", (S, S), 0)] * 3, lay.getchannel("A").point(lambda v: v * 0.3)))
    if name not in ("Halo",):
        canvas.alpha_composite(fast_blur(sh, 10), (0, int(U(8))))
    canvas.alpha_composite(lay)


# =============================== ACCESSORIES ===============================
def chain(d, pts_fn, n, col, hi, link=10):
    w_ = int(U(link * 0.42))
    for k in range(n):
        t = k / (n - 1)
        px, py = pts_fn(t)
        r = U(link)
        if k % 2:
            d.ellipse([px - r * .5, py - r * .85, px + r * .5, py + r * .85], outline=col, width=w_)
        else:
            d.ellipse([px - r * .85, py - r * .5, px + r * .85, py + r * .5], outline=col, width=w_)
            d.arc([px - r * .85, py - r * .5, px + r * .85, py + r * .5], 200, 300, fill=hi, width=max(2, w_ // 2))


def necklace_curve(depth=110):
    a = (190, 462); b = (390, 462)
    def f(t):
        xx = a[0] + (b[0] - a[0]) * t
        yy = a[1] + depth * math.sin(math.pi * t) * 0.9
        return P(xx, yy)
    return f


def accessory(canvas, name, behind=False):
    if name == "None":
        return
    if behind != (name == "$GC Neon Sign"):
        return
    lay = new_layer(); d = ImageDraw.Draw(lay)
    def x(v): return P(v, 0)[0]
    def y(v): return P(0, v)[1]
    if name == "$GC Neon Sign":
        fnt = font("Anton-Regular.ttf", 400)
        tl = new_layer(); td = ImageDraw.Draw(tl)
        x0, y0, x1, y1 = 90, 110, 760, 640
        td.rounded_rectangle([x0, y0, x1, y1], radius=70, outline=(255, 60, 200, 255), width=22)
        td.text(((x0 + x1) / 2, (y0 + y1) / 2), "$GC", font=fnt, fill=None, anchor="mm",
                stroke_width=16, stroke_fill=(184, 255, 0, 255))
        add_glow(canvas, tl, 30, 1.0, 2)
        core = new_layer(); cd = ImageDraw.Draw(core)
        cd.text(((x0 + x1) / 2, (y0 + y1) / 2), "$GC", font=fnt, fill=None, anchor="mm",
                stroke_width=5, stroke_fill=(245, 255, 220, 255))
        cd.rounded_rectangle([x0 + 8, y0 + 8, x1 - 8, y1 - 8], radius=64, outline=(255, 220, 245, 255), width=6)
        canvas.alpha_composite(core)
        return
    if name in ("Silver Chain", "Gold Chain", "Diamond Chain", "$GC Pendant"):
        gold = name != "Silver Chain"
        col = (232, 182, 50, 255) if gold else (210, 214, 224, 255)
        hi = (255, 244, 190, 255) if gold else (255, 255, 255, 255)
        link = 17 if name in ("Gold Chain", "Diamond Chain", "$GC Pendant") else 13
        depth = 105 if name == "Silver Chain" else 125
        chain(d, necklace_curve(depth), 20 if link > 15 else 24, col, hi, link)
        px, py = necklace_curve(depth)(0.5)
        if name == "$GC Pendant":
            r = U(58)
            d.ellipse([px - r, py - r * .2, px + r, py + r * 1.8], fill=(232, 182, 50, 255))
            d.ellipse([px - r * .8, py, px + r * .8, py + r * 1.6], fill=(30, 110, 40, 255))
            fnt = font("Anton-Regular.ttf", U(54))
            d.text((px, py + r * .8), "$GC", font=fnt, fill=(184, 255, 0, 255), anchor="mm")
        if name == "Diamond Chain":
            r = U(56)
            pts = [(px - r, py + r * .3), (px - r * .5, py - r * .2), (px + r * .5, py - r * .2), (px + r, py + r * .3), (px, py + r * 1.6)]
            g = new_layer(); gd = ImageDraw.Draw(g)
            gd.polygon(pts, fill=(170, 235, 255, 255))
            gd.polygon([(px - r * .5, py - r * .2), (px, py + r * .3), (px + r * .5, py - r * .2)], fill=(230, 252, 255, 255))
            gd.polygon([(px - r, py + r * .3), (px, py + r * .3), (px, py + r * 1.6)], fill=(120, 200, 240, 255))
            sparkle(gd, px + r * .7, py - r * .1, U(18), (255, 255, 255, 255))
            add_glow(lay, g, 12, 1, 1)
    elif name == "Bow Tie":
        cx, cy = P(290, 482)
        col = (210, 30, 50, 255)
        d.polygon([(cx, cy), (cx - U(88), cy - U(50)), (cx - U(96), cy), (cx - U(88), cy + U(50))], fill=col)
        d.polygon([(cx, cy), (cx + U(88), cy - U(50)), (cx + U(96), cy), (cx + U(88), cy + U(50))], fill=col)
        for k in (-1, 1):
            for j in range(3):
                px_ = cx + k * U(40 + j * 18); d.ellipse([px_ - U(6), cy - U(16) + j * U(10) - U(6), px_ + U(6), cy - U(16) + j * U(10) + U(6)], fill=(255, 255, 255, 220))
        d.rounded_rectangle([cx - U(22), cy - U(26), cx + U(22), cy + U(26)], radius=U(8), fill=(170, 20, 40, 255))
    elif name == "Scarf":
        col, st = (250, 150, 30, 255), (250, 240, 220, 255)
        d.rounded_rectangle([x(165), y(430), x(415), y(492)], radius=U(30), fill=col)
        for k in range(6):
            xx = x(185 + k * 42)
            d.line([(xx, y(434)), (xx, y(488))], fill=st, width=int(U(10)))
        d.polygon([(x(330), y(470)), (x(390), y(470)), (x(398), y(640)), (x(338), y(630))], fill=col)
        for k in range(3):
            yy = y(510 + k * 40)
            d.line([(x(334), yy), (x(394), yy + U(2))], fill=st, width=int(U(10)))
        for k in range(5):
            xx = x(342 + k * 12)
            d.line([(xx, y(634)), (xx, y(660))], fill=col, width=int(U(5)))
    elif name == "Coffee Cup":
        Z = lambda v: U(v) * 1.55
        hx, hy = P(472, 660)
        w, h = Z(64), Z(96)
        d.polygon([(hx - w / 2, hy - h), (hx + w / 2, hy - h), (hx + w * .38, hy), (hx - w * .38, hy)], fill=(250, 248, 240, 255))
        d.polygon([(hx - w * .47, hy - h * .7), (hx + w * .47, hy - h * .7), (hx + w * .42, hy - h * .3), (hx - w * .42, hy - h * .3)], fill=(150, 100, 60, 255))
        d.rounded_rectangle([hx - w * .58, hy - h - Z(16), hx + w * .58, hy - h + Z(2)], radius=Z(6), fill=(60, 50, 44, 255))
        d.ellipse([hx - Z(10), hy - h * .56 - Z(10), hx + Z(10), hy - h * .56 + Z(10)], fill=(184, 255, 0, 255))
        for k in (-1, 1):
            pts = [(hx + k * Z(12) + Z(8) * math.sin(j / 2), hy - h - Z(24) - j * Z(6)) for j in range(9)]
            d.line(pts, fill=(255, 255, 255, 140), width=int(Z(5)))
    elif name == "Balloon":
        Z = lambda v: U(v) * 1.25
        hx, hy = P(96, 680)
        bx, by = P(-110, 300)
        d.line([(hx, hy), (bx + Z(20), by + Z(150)), (bx, by + Z(100))], fill=(240, 240, 240, 255), width=int(Z(3)))
        bal = new_layer(); bd = ImageDraw.Draw(bal)
        bd.ellipse([bx - Z(78), by - Z(100), bx + Z(78), by + Z(100)], fill=(255, 80, 150, 255))
        bd.polygon([(bx - Z(12), by + Z(112)), (bx + Z(12), by + Z(112)), (bx, by + Z(96))], fill=(230, 60, 130, 255))
        bd.ellipse([bx - Z(48), by - Z(70), bx - Z(18), by - Z(20)], fill=(255, 200, 225, 220))
        lay.alpha_composite(bal)
    elif name == "Cassette Tape":
        Z = lambda v: U(v) * 1.5
        hx, hy = P(470, 640)
        w, h = Z(120), Z(78)
        d.rounded_rectangle([hx - w / 2, hy - h / 2, hx + w / 2, hy + h / 2], radius=Z(8), fill=(32, 32, 38, 255))
        d.rounded_rectangle([hx - w * .42, hy - h * .38, hx + w * .42, hy + h * .12], radius=Z(5), fill=(255, 120, 170, 255))
        d.rectangle([hx - w * .42, hy - h * .38, hx + w * .42, hy - h * .26], fill=(184, 255, 0, 255))
        for k in (-1, 1):
            d.ellipse([hx + k * w * .2 - Z(11), hy - Z(11) - h * .1, hx + k * w * .2 + Z(11), hy + Z(11) - h * .1], fill=(250, 250, 250, 255))
            d.ellipse([hx + k * w * .2 - Z(5), hy - Z(5) - h * .1, hx + k * w * .2 + Z(5), hy + Z(5) - h * .1], fill=(32, 32, 38, 255))
        d.polygon([(hx - w * .3, hy + h / 2), (hx - w * .22, hy + h * .25), (hx + w * .22, hy + h * .25), (hx + w * .3, hy + h / 2)], fill=(60, 60, 70, 255))
    elif name == "Vinyl Record":
        Z = lambda v: U(v) * 1.35
        hx, hy = P(100, 610)
        r = Z(80)
        d.ellipse([hx - r, hy - r, hx + r, hy + r], fill=(16, 16, 18, 255))
        for k in range(3, 8):
            rr = r * k / 8
            d.ellipse([hx - rr, hy - rr, hx + rr, hy + rr], outline=(44, 44, 50, 255), width=int(Z(1.5)))
        d.ellipse([hx - r * .3, hy - r * .3, hx + r * .3, hy + r * .3], fill=(184, 255, 0, 255))
        d.ellipse([hx - Z(4), hy - Z(4), hx + Z(4), hy + Z(4)], fill=(16, 16, 18, 255))
        d.arc([hx - r * .9, hy - r * .9, hx + r * .9, hy + r * .9], 200, 250, fill=(140, 140, 160, 255), width=int(Z(3)))
    elif name == "Sol-Gradient Coin":
        Z = lambda v: U(v) * 1.45
        hx, hy = P(472, 640)
        r = Z(56)
        coin = to_img(lin_grad(S, S, [(0, (153, 69, 255)), (1, (20, 241, 149))], angle=45))
        m = Image.new("L", (S, S), 0); ImageDraw.Draw(m).ellipse([hx - r, hy - r, hx + r, hy + r], fill=255)
        coin.putalpha(m); lay.alpha_composite(coin); d = ImageDraw.Draw(lay)
        d.ellipse([hx - r * .78, hy - r * .78, hx + r * .78, hy + r * .78], outline=(255, 255, 255, 200), width=int(Z(4)))
        # paw print emblem (generic, no brand marks)
        d.ellipse([hx - Z(18), hy - Z(4), hx + Z(18), hy + Z(26)], fill=(255, 255, 255, 235))
        for (a, b) in ((-24, -14), (-9, -26), (9, -26), (24, -14)):
            d.ellipse([hx + Z(a) - Z(8), hy + Z(b) - Z(9), hx + Z(a) + Z(8), hy + Z(b) + Z(9)], fill=(255, 255, 255, 235))
    lay = vinylize(lay, 0.45, 5.0)
    sh = Image.merge("RGBA", (*[Image.new("L", (S, S), 0)] * 3, lay.getchannel("A").point(lambda v: v * 0.3)))
    canvas.alpha_composite(fast_blur(sh, 6), (0, int(U(5))))
    canvas.alpha_composite(lay)


# =============================== AURA / FX ===============================
def cat_alpha_canvas(cat: Image.Image):
    full = new_layer(); full.alpha_composite(cat, (int(round(CX0 * SS)), int(round(CY0 * SS))))
    return full.getchannel("A")


def aura_behind(canvas, name, cat_a, fur):
    cols = {"Lime Glow": (184, 255, 0), "Gold Aura": (255, 200, 60), "Neon Aura": (255, 60, 210)}
    if fur == "Glow-in-the-Dark" and name not in cols:
        name, cols["_"] = "_", (150, 255, 160)
    if name not in cols:
        return
    col = cols[name]
    glow = Image.merge("RGBA", (*[Image.new("L", (S, S), c) for c in col], cat_a))
    big = fast_blur(glow.filter(ImageFilter.MaxFilter(9)), 40)
    canvas.alpha_composite(big); canvas.alpha_composite(big)
    if name == "Neon Aura":
        g2 = Image.merge("RGBA", (*[Image.new("L", (S, S), c) for c in (0, 230, 255)], cat_a))
        canvas.alpha_composite(fast_blur(g2.filter(ImageFilter.MaxFilter(21)), 70))
    if name == "Gold Aura":
        lay = new_layer(); d = ImageDraw.Draw(lay)
        cx, cy = S / 2, S * .5
        for k in range(24):
            a = k / 24 * 2 * math.pi
            d.polygon([(cx, cy), (cx + math.cos(a - .04) * S, cy + math.sin(a - .04) * S), (cx + math.cos(a + .04) * S, cy + math.sin(a + .04) * S)], fill=(255, 230, 140, 46))
        canvas.alpha_composite(fast_blur(lay, 6))


def sparkles_front(canvas, cat_a, rng):
    ca = np.asarray(cat_a)
    d = ImageDraw.Draw(canvas)
    placed = 0; tries = 0
    while placed < 14 and tries < 400:
        tries += 1
        x, y = int(rng.random() * S), int(rng.random() * S * .9)
        if ca[y, x] > 0:
            continue
        r = 28 + rng.random() * 52
        sparkle(d, x, y, r, (255, 255, 235, 240)); placed += 1


def laser_beams(canvas, eyewear_name):
    lay = new_layer(); d = ImageDraw.Draw(lay)
    for (c, tx) in ((P(*EYE_L_C), -S * 0.1), (P(*EYE_R_C), S * 1.1)):
        end = (tx, c[1] + S * 0.18)
        d.line([c, end], fill=(255, 30, 30, 235), width=int(U(22)))
        d.line([c, end], fill=(255, 220, 200, 255), width=int(U(7)))
    add_glow(canvas, lay, 22, 1.0, 2)


def ground_shadow(canvas, dark_bg):
    lay = new_layer(); d = ImageDraw.Draw(lay)
    cx, cy = P(290, 852)
    d.ellipse([cx - U(210), cy - U(26), cx + U(210), cy + U(26)], fill=(0, 0, 0, 150 if dark_bg else 90))
    canvas.alpha_composite(fast_blur(lay, 14))


# =============================== COMPOSE ===============================
def token_rng(token_id):
    import random
    return random.Random(C.hash_seed(f"{C.CATALOG_SEED}:{C.ART_VERSION}:render:{token_id}"))


def render_token(token_id: int) -> Image.Image:
    return render_traits(C.token_entry(token_id)["traits"], token_id)


def render_traits(t: dict, token_id: int) -> Image.Image:
    rng = token_rng(token_id)
    canvas = background(t["Background"], rng)
    cat = build_cat(t, rng)
    ca = cat_alpha_canvas(cat)
    accessory(canvas, t["Accessory"], behind=True)
    aura_behind(canvas, t["Aura"], ca, t["Fur"])
    ground_shadow(canvas, t["Background"] in DARK_BGS)
    canvas.alpha_composite(cat, (int(round(CX0 * SS)), int(round(CY0 * SS))))
    eyewear(canvas, t["Eyewear"], t["Eyes"])
    accessory(canvas, t["Accessory"], behind=False)
    hat(canvas, t["Hat"], rng)
    if t["Eyes"] == "Laser Eyes":
        laser_beams(canvas, t["Eyewear"])
    if t["Aura"] == "Sparkles":
        sparkles_front(canvas, ca, rng)
    return canvas.convert("RGB").resize((OUT, OUT), Image.LANCZOS)
