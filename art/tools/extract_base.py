"""Extract the front view from the character reference sheet -> transparent, upscaled base render.
Colour-key matte (cat is saturated green, sheet bg is neutral grey) + hole fill (eyes/pupils/nose)
+ edge colour decontamination + Lanczos upscale + unsharp. Deterministic, no AI, no network."""
from PIL import Image, ImageFilter
import numpy as np
from scipy import ndimage as ndi
import os
HERE = os.path.dirname(os.path.abspath(__file__)); ART = os.path.dirname(HERE)
src = Image.open(os.path.join(ART, "source/character-reference-sheet.jpg")).convert("RGB")
X0, Y0, X1, Y1 = 14, 205, 400, 790          # front view box (sheet is 1792x1008)
crop = np.asarray(src.crop((X0, Y0, X1, Y1))).astype(np.float32)
r, g, b = crop[..., 0], crop[..., 1], crop[..., 2]
gr = g - np.maximum(r, b)
# pass 1: obvious green -> background estimate B (smooth grey gradient of the sheet)
m0 = ndi.binary_fill_holes(gr > 22)
bgmask = ~ndi.binary_dilation(m0, iterations=6)
B = np.zeros_like(crop)
for c in range(3):
    B[..., c] = ndi.gaussian_filter(crop[..., c] * bgmask, 15) / (ndi.gaussian_filter(bgmask.astype(np.float32), 15) + 1e-4)
dist = np.sqrt(((crop - B) ** 2).sum(-1))
# pass 2: anything clearly different from the grey bg AND slightly green (keeps pale rim light,
# rejects the neutral grey floor shadow)
hard = ((dist > 14) & (gr > 3)) | (gr > 22)
hard = ndi.binary_opening(hard, iterations=1)
lab, n = ndi.label(hard); sizes = ndi.sum(hard, lab, range(1, n + 1))
hard = lab == (1 + int(np.argmax(sizes)))          # keep the cat only
filled = ndi.binary_fill_holes(ndi.binary_closing(hard, iterations=3))
soft = np.clip((dist - 5) / (16 - 5), 0, 1) * (gr > 0)
interior = ndi.binary_erosion(filled, iterations=2)
band = ndi.binary_dilation(filled, iterations=2) & ~interior
alpha = np.where(interior, 1.0, np.where(band, soft, 0.0))
a3 = np.clip(alpha, 0.05, 1)[..., None]
F = np.where(band[..., None], (crop - (1 - a3) * B) / a3, crop)
F = np.clip(F, 0, 255)
rgba = np.dstack([F, alpha * 255]).astype(np.uint8)
im = Image.fromarray(rgba, "RGBA")
bbox = im.getbbox(); im = im.crop(bbox)
# upscale so the figure is 860 px tall (for 1024 canvas), Lanczos on premultiplied colour
H = 860; W = round(im.width * H / im.height)
arr = np.asarray(im).astype(np.float32) / 255
pm = np.dstack([arr[..., :3] * arr[..., 3:4], arr[..., 3]])
up = np.asarray(Image.fromarray((pm * 255).astype(np.uint8), "RGBA").resize((W, H), Image.LANCZOS)).astype(np.float32) / 255
a = up[..., 3:4]; rgb = np.where(a > 1e-3, up[..., :3] / np.maximum(a, 1e-3), 0)
out = Image.fromarray(np.dstack([np.clip(rgb, 0, 1) * 255, a * 255]).astype(np.uint8), "RGBA")
rgbim = out.convert("RGB").filter(ImageFilter.UnsharpMask(radius=2.2, percent=70, threshold=2))
out = Image.merge("RGBA", (*rgbim.split(), out.split()[3]))
os.makedirs(os.path.join(ART, "base"), exist_ok=True)
out.save(os.path.join(ART, "base/greencat-base-front.png"), optimize=True)
# also save the matte at source res for QA
im.save(os.path.join(ART, "base/greencat-base-front@source-res.png"))
print("base", out.size, "source crop", im.size)
