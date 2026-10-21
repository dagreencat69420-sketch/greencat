import fs from "node:fs/promises";
import path from "node:path";
import { COLLECTION_SIZE } from "@greencat/sdk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Local preview of the rendered art-v1 collection: GET /nft/images/{tokenId}.webp
 * Reads from ART_IMAGES_DIR (default: <repo>/art/out/images-webp). Production should point
 * NEXT_PUBLIC_NFT_IMAGE_BASE at the uploaded IPFS/CDN image base instead; if the directory
 * is absent this returns 404 and the UI falls back to a rarity placeholder.
 */
function imagesDir(): string {
  return process.env.ART_IMAGES_DIR?.trim() || path.resolve(process.cwd(), "..", "..", "art", "out", "images-webp");
}

export async function GET(_req: Request, { params }: { params: { file: string } }) {
  const m = /^(\d{1,5})\.webp$/.exec(params.file);
  const id = m ? Number(m[1]) : NaN;
  if (!Number.isInteger(id) || id < 1 || id > COLLECTION_SIZE) {
    return new Response("not found", { status: 404 });
  }
  try {
    const buf = await fs.readFile(path.join(imagesDir(), `${id}.webp`));
    return new Response(new Uint8Array(buf), {
      headers: {
        "Content-Type": "image/webp",
        "Cache-Control": "public, max-age=86400, immutable",
      },
    });
  } catch {
    return new Response("not found", { status: 404 });
  }
}
