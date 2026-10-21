"""Convert PNG masters (out/images/{id}.png) -> WebP q92 (out/images-webp/{id}.webp). PNGs are kept.
Resumable (skips existing non-empty outputs). Usage: python tools/convert_webp.py [--workers 6] [--quality 92]"""
import argparse, os, sys, time
from concurrent.futures import ProcessPoolExecutor
from PIL import Image
ART = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ART, "out", "images"); DST = os.path.join(ART, "out", "images-webp")

def conv(args):
    tid, q = args
    d = os.path.join(DST, f"{tid}.webp")
    if os.path.exists(d) and os.path.getsize(d) > 0:
        return tid, os.path.getsize(d)
    tmp = d + ".tmp"
    with Image.open(os.path.join(SRC, f"{tid}.png")) as im:
        im.convert("RGB").save(tmp, "WEBP", quality=q, method=6)
    os.replace(tmp, d)
    return tid, os.path.getsize(d)

if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("--workers", type=int, default=6); ap.add_argument("--quality", type=int, default=92)
    a = ap.parse_args(); os.makedirs(DST, exist_ok=True)
    t = time.time(); total = 0
    with ProcessPoolExecutor(a.workers) as ex:
        for k, (tid, sz) in enumerate(ex.map(conv, [(i, a.quality) for i in range(1, 10001)], chunksize=50), 1):
            total += sz
            if k % 1000 == 0: print(f"{k}/10000 {time.time()-t:.0f}s", flush=True)
    print(f"done 10000 webp q{a.quality} in {time.time()-t:.0f}s, total {total} bytes ({total/1e9:.3f} GB)")
