# GreenCat mascot (clean version)

Source: the front view cut from the owner's turnaround sheet (glossy lime vinyl figure).
Method: crop of the front view, 4x upscale with Real-ESRGAN x4plus (ONNX, CPU), background removed with
rembg `isnet-general-use`, edge colours decontaminated so no grey fringe on dark backgrounds. No generative
redraw, so the character matches the reference exactly.

| File | Use |
| --- | --- |
| `greencat-mascot-full.png` | Full body, transparent, 1106x1600 (hero / press) |
| `greencat-mascot-square.png` | Head + shoulders, transparent, 1024x1024 (logo / avatar / social) |
| `greencat-mascot-head.png` | Head only, transparent, 1024x1024 (small avatars) |
| `greencat-favicon-512.png` | Head on dark rounded square, 512x512 (favicon / app icon source) |
| `before-*` | The old assets (blue background with $ symbols), kept for reference |
| `compare-*.png` | Before / after for each spot on the site |
| `screenshots/after-*.png` | Live site after deploy (home desktop + mobile, mint, market, stake, wheel) |
| `screenshots/before-*.webp` | Live site before the change |

Web copies (optimized): `apps/web/public/mascot/greencat-full.webp` (553x800, hero),
`apps/web/public/mascot/greencat-avatar.webp` (256x256 head, nav / footer / launch card),
`apps/web/src/app/icon.png` (favicon), `apple-icon.png`, `opengraph-image.jpg`, `twitter-image.jpg`.
