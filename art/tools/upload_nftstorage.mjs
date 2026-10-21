#!/usr/bin/env node
/**
 * GreenCat art-v1 -> IPFS + NFT.Storage (Filecoin long-term preservation).
 *
 * HOW THE CURRENT NFT.Storage WORKS (checked 2026-09-30, app.nft.storage/v1/docs):
 *   The current product (preserve.nft.storage, $4.99/GB one-time) does NOT accept file bytes. The old
 *   `api.nft.storage/upload` + `nft.storage` JS client were "NFT.Storage Classic", which closed to uploads
 *   on 2024-06-30. Now you register a collection and submit a CSV of token -> CID. NFT.Storage then PINS
 *   those CIDs from the public IPFS network and makes Filecoin deals. So the content must first be
 *   reachable on IPFS, from a "hot" provider that keeps serving it.
 *
 * What this script does:
 *   1. Preflight: checks that all 10,000 art/out/images-webp/{id}.webp files exist and are non-empty.
 *   2. Packs the WebP folder into ONE CAR locally (ipfs-car; CIDv1, raw leaves). The root CID is the
 *      images directory, so `ipfs://<IMAGES_CID>/{id}.webp` works.
 *   3. Regenerates all metadata with base `ipfs://<IMAGES_CID>/` (python greencat_art.py metadata --base),
 *      then packs the metadata folder (1.json..10000.json) into a CAR. Its root CID is the base URI for
 *      `initialize_collection`: `ipfs://<METADATA_CID>/`.
 *   4. Publishes both CARs to a hot IPFS provider:
 *        --ipfs kubo  (default, free) runs `dag import` with pinned roots into a running Kubo daemon
 *                     (KUBO_API, default http://127.0.0.1:5001), then announces the roots to the DHT.
 *                     The node must stay online until NFT.Storage shows every token "Complete".
 *        --ipfs none  means you already uploaded out/ipfs/*.car somewhere (e.g. a paid Pinata plan with
 *                     car=true, or Filebase CAR import). The script only checks reachability via the gateway.
 *   5. NFT.Storage: checks the balance, creates (or reuses) a Solana collection, then uploads the CSV
 *      `tokenAddress,cid`: one row per image file CID + one per metadata file CID. Because GreenCat mints
 *      do not exist before mint, tokenAddress uses stable placeholders (GCAT-IMG-<id> / GCAT-META-<id>).
 *      CONFIRM this with NFT.Storage support first (see art/UPLOAD-PLAN.md).
 *   6. Prints both CIDs, gateway test URLs for tokens 1/42/10000, and writes out/ipfs/manifest.json.
 *
 * Usage (from greencat-app/art):
 *   node tools/upload_nftstorage.mjs --dry-run            # free, offline: real CIDs + CSV + manifest, NO network calls
 *   NFT_STORAGE_API_KEY=... node tools/upload_nftstorage.mjs --ipfs kubo
 *   Options: --ipfs kubo|none   --skip-nftstorage   --collection-name "GreenCat"   --chain-id 101
 *            --contract <string> (Solana has no contract address; NFT.Storage wants a unique string)
 *            --csv-batch 5000    --gateway https://ipfs.io/ipfs/
 *            --ipfs skip (CIDs already hot)   --rows A:B (send only CSV data rows A..B, 1-based; for a test batch / resume)
 *            --network solana (value the NFT.Storage dashboard sends for Solana)
 *            --no-promote (don't copy staged metadata into out/metadata after a live run; for testing)
 * Env: NFT_STORAGE_API_KEY (required unless --dry-run/--skip-nftstorage), KUBO_API, NFTSTORAGE_API
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ART = path.resolve(HERE, "..");
const OUT = path.join(ART, "out");
const IMG_DIR = path.join(OUT, "images-webp");
const STAGE = path.join(OUT, "ipfs");
const STAGE_MD = path.join(STAGE, "metadata");
const IMG_CAR = path.join(STAGE, "images-webp.car");
const MD_CAR = path.join(STAGE, "metadata.car");
const IPFS_CAR = path.join(HERE, "ipfs", "node_modules", ".bin", "ipfs-car");
const PY = fs.existsSync(path.join(ART, ".venv", "bin", "python")) ? path.join(ART, ".venv", "bin", "python") : "python3";
const N = 10_000;
const PRICE_PER_GB = 4.99;
const SPOT = [1, 42, 10000];

function args() {
  const a = { dryRun: false, ipfs: "kubo", skipNft: false, collectionName: "GreenCat (GCAT) art-v1", chainId: "101",
    contract: "greencat-gcat-art-v1", csvBatch: 5000, gateway: "https://ipfs.filebase.io/ipfs/", promote: true, network: "solana", rows: null };
  const v = process.argv.slice(2);
  for (let i = 0; i < v.length; i++) {
    const k = v[i];
    if (k === "--dry-run") a.dryRun = true;
    else if (k === "--skip-nftstorage") a.skipNft = true;
    else if (k === "--no-promote") a.promote = false;
    else if (k === "--network") a.network = v[++i];
    else if (k === "--expect") a.expect = v[++i].split(","); // IMAGES_CID,METADATA_CID: abort if packing yields anything else
    else if (k === "--rows") { const [x, y] = v[++i].split(":").map(Number); a.rows = [x, y]; } // 1-based inclusive data-row range
    else if (k === "--ipfs") a.ipfs = v[++i];
    else if (k === "--collection-name") a.collectionName = v[++i];
    else if (k === "--chain-id") a.chainId = v[++i];
    else if (k === "--contract") a.contract = v[++i];
    else if (k === "--csv-batch") a.csvBatch = Number(v[++i]);
    else if (k === "--gateway") a.gateway = v[++i];
    else if (k === "-h" || k === "--help") { console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]); process.exit(0); }
    else throw new Error(`unknown arg ${k}`);
  }
  if (!["kubo", "none", "skip"].includes(a.ipfs)) throw new Error("--ipfs must be kubo|none|skip");
  if (!a.gateway.endsWith("/")) a.gateway += "/";
  return a;
}

const log = (...m) => console.log(...m);
const step = (m) => console.log(`\n== ${m}`);

function preflight() {
  const bad = [];
  let bytes = 0;
  for (let id = 1; id <= N; id++) {
    const p = path.join(IMG_DIR, `${id}.webp`);
    try {
      const s = fs.statSync(p);
      if (s.size === 0) bad.push(id); else bytes += s.size;
    } catch { bad.push(id); }
  }
  const extra = fs.readdirSync(IMG_DIR).filter((f) => !/^\d+\.webp$/.test(f));
  if (bad.length) throw new Error(`missing/empty WebP for ${bad.length} tokens, e.g. ${bad.slice(0, 10)}`);
  if (extra.length) throw new Error(`unexpected files in ${IMG_DIR}: ${extra.slice(0, 5)} (they would be published)`);
  return bytes;
}

function packCar(dir, car) {
  fs.mkdirSync(path.dirname(car), { recursive: true });
  const out = execFileSync(IPFS_CAR, ["pack", dir, "--output", car], { encoding: "utf8", maxBuffer: 1 << 26 }).trim();
  const root = out.split(/\s+/).pop();
  if (!/^bafy[a-z2-7]+$/.test(root)) throw new Error(`unexpected root CID output: ${out}`);
  return root;
}

function listCar(car) {
  const out = execFileSync(IPFS_CAR, ["ls", car, "--verbose"], { encoding: "utf8", maxBuffer: 1 << 28 });
  const files = new Map();
  for (const line of out.split("\n")) {
    const [cid, size, p] = line.split("\t");
    if (p && p !== ".") files.set(p.replace(/^\.\//, ""), { cid, size: Number(size) });
  }
  return files;
}

function regenMetadata(imagesCid) {
  fs.rmSync(STAGE_MD, { recursive: true, force: true });
  execFileSync(PY, [path.join(ART, "greencat_art.py"), "metadata", "--base", `ipfs://${imagesCid}/`, "--out", STAGE_MD], { stdio: "inherit" });
  const files = fs.readdirSync(STAGE_MD);
  if (files.length !== N) throw new Error(`expected ${N} metadata files, got ${files.length}`);
  for (const id of SPOT) {
    const md = JSON.parse(fs.readFileSync(path.join(STAGE_MD, `${id}.json`), "utf8"));
    const want = `ipfs://${imagesCid}/${id}.webp`;
    if (md.image !== want || md.properties.files[0].uri !== want || md.properties.files[0].type !== "image/webp")
      throw new Error(`metadata ${id} image mismatch: ${md.image}`);
  }
}

async function kuboImport(car, root, api) {
  const fd = new FormData();
  fd.append("file", await fs.openAsBlob(car), path.basename(car));
  const r = await fetch(`${api}/api/v0/dag/import?pin-roots=true&stats=true`, { method: "POST", body: fd });
  const text = await r.text();
  if (!r.ok) throw new Error(`kubo dag/import ${r.status}: ${text}`);
  if (!text.includes(root)) throw new Error(`kubo did not report root ${root}: ${text.slice(0, 500)}`);
  log(`  imported + pinned ${root}`);
  const p = await fetch(`${api}/api/v0/routing/provide?arg=${root}&recursive=false`, { method: "POST" });
  log(`  DHT provide root: HTTP ${p.status}${p.ok ? "" : " (non-fatal; Kubo's reprovider will announce it)"}`);
}

async function nft(apiKey, base, method, url, body, headers = {}) {
  const r = await fetch(`${base}${url}`, { method, body, headers: { Authorization: `Bearer ${apiKey}`, ...headers } });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  if (!r.ok) throw new Error(`NFT.Storage ${method} ${url} -> ${r.status}: ${text.slice(0, 500)}`);
  return json;
}

function csvRows(imgFiles, mdFiles) {
  const rows = [];
  for (let id = 1; id <= N; id++) {
    rows.push(`GCAT-IMG-${id},${imgFiles.get(`${id}.webp`).cid}`);
    rows.push(`GCAT-META-${id},${mdFiles.get(`${id}.json`).cid}`);
  }
  return rows;
}

function findCollectionId(list, name, contract) {
  const arr = Array.isArray(list) ? list : list?.value ?? list?.data ?? list?.collections ?? [];
  const hit = arr.find((c) => c.contractAddress === contract || c.collectionName === name);
  return hit && (hit.collectionID ?? hit.collectionId ?? hit.id ?? hit._id);
}

async function main() {
  const a = args();
  const t0 = Date.now();
  log(`GreenCat art-v1 -> IPFS + NFT.Storage ${a.dryRun ? "[DRY RUN: no network calls, nothing uploaded]" : "[LIVE]"}`);
  const apiKey = process.env.NFT_STORAGE_API_KEY?.trim();
  if (!a.dryRun && !a.skipNft && !apiKey) throw new Error("NFT_STORAGE_API_KEY is not set (or use --dry-run / --skip-nftstorage)");
  if (!fs.existsSync(IPFS_CAR)) throw new Error(`ipfs-car missing; run: (cd ${path.join(HERE, "ipfs")} && npm install)`);

  step("1/6 preflight");
  const imgBytes = preflight();
  log(`  ${N} WebP files OK, ${imgBytes} bytes (${(imgBytes / 1e9).toFixed(3)} GB)`);

  step("2/6 pack images CAR");
  const imagesCid = packCar(IMG_DIR, IMG_CAR);
  const imgFiles = listCar(IMG_CAR);
  if (imgFiles.size !== N) throw new Error(`images CAR lists ${imgFiles.size} files`);
  log(`  IMAGES_CID ${imagesCid}  (${IMG_CAR}, ${fs.statSync(IMG_CAR).size} bytes)`);

  step("3/6 regenerate metadata with ipfs://IMAGES_CID/ + pack metadata CAR");
  regenMetadata(imagesCid);
  const metadataCid = packCar(STAGE_MD, MD_CAR);
  const mdFiles = listCar(MD_CAR);
  if (mdFiles.size !== N) throw new Error(`metadata CAR lists ${mdFiles.size} files`);
  log(`  METADATA_CID ${metadataCid}  (${MD_CAR}, ${fs.statSync(MD_CAR).size} bytes)`);

  if (a.expect && (a.expect[0] !== imagesCid || a.expect[1] !== metadataCid))
    throw new Error(`CID mismatch vs --expect: got ${imagesCid},${metadataCid}`);
  if (a.expect) log("  CIDs match --expect (locked)");
  const rows = csvRows(imgFiles, mdFiles);
  const csvPath = path.join(STAGE, "nftstorage-tokens.csv");
  fs.writeFileSync(csvPath, ["tokenAddress,cid", ...rows].join("\n") + "\n");
  const totalBytes = fs.statSync(IMG_CAR).size + fs.statSync(MD_CAR).size;
  const manifest = {
    createdAt: new Date().toISOString(), dryRun: a.dryRun, catalogSeed: "greencat-meme-collection-v1", artVersion: "art-v1",
    imagesCid, metadataCid, imageBase: `ipfs://${imagesCid}/`, metadataBaseUri: `ipfs://${metadataCid}/`,
    imagesCar: { path: IMG_CAR, bytes: fs.statSync(IMG_CAR).size }, metadataCar: { path: MD_CAR, bytes: fs.statSync(MD_CAR).size },
    nftstorageCsv: { path: csvPath, rows: rows.length }, estimatedNftStorageUSD: +((totalBytes / 1e9) * PRICE_PER_GB).toFixed(2),
    spot: Object.fromEntries(SPOT.map((id) => [id, { image: imgFiles.get(`${id}.webp`).cid, metadata: mdFiles.get(`${id}.json`).cid }])),
  };
  fs.writeFileSync(path.join(STAGE, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  log(`  CSV ${csvPath} (${rows.length} rows); manifest ${path.join(STAGE, "manifest.json")}`);
  log(`  billable size ~${(totalBytes / 1e9).toFixed(3)} GB -> NFT.Storage est. $${manifest.estimatedNftStorageUSD} at $${PRICE_PER_GB}/GB`);

  step(`4/6 publish to hot IPFS (${a.ipfs})`);
  if (a.dryRun) log(`  [dry-run] would ${a.ipfs === "kubo" ? `POST ${process.env.KUBO_API || "http://127.0.0.1:5001"}/api/v0/dag/import (pin-roots) for both CARs` : "only check gateway reachability"}`);
  else if (a.ipfs === "skip") log("  skipped (--ipfs skip: CIDs already hot, e.g. pinned on Kubo + 4EVER Pin)");
  else if (a.ipfs === "kubo") {
    const api = process.env.KUBO_API || "http://127.0.0.1:5001";
    const id = await fetch(`${api}/api/v0/id`, { method: "POST" }).then((r) => r.json());
    log(`  kubo peer ${id.ID}`);
    await kuboImport(IMG_CAR, imagesCid, api);
    await kuboImport(MD_CAR, metadataCid, api);
  } else {
    for (const c of [imagesCid, metadataCid]) {
      const r = await fetch(`${a.gateway}${c}/1.${c === imagesCid ? "webp" : "json"}`, { method: "HEAD" }).catch((e) => ({ ok: false, status: String(e) }));
      log(`  gateway check ${c}: ${r.status}${r.ok ? "" : "  <- not reachable yet; NFT.Storage pinning may fail"}`);
    }
  }

  step("5/6 NFT.Storage preservation");
  const NFT_API = process.env.NFTSTORAGE_API || "https://preserve.nft.storage";
  if (a.dryRun || a.skipNft) {
    log(`  [${a.dryRun ? "dry-run" : "skipped"}] would: GET ${NFT_API}/api/v1/user/get_balance`);
    log(`    POST /api/v1/collection/create_collection {collectionName:${JSON.stringify(a.collectionName)}, contractAddress:${JSON.stringify(a.contract)}, chainID:${JSON.stringify(a.chainId)}, network:${JSON.stringify(a.network)}}`);
    log(`    GET /api/v1/collection/list_collections -> collectionID`);
    log(`    POST /api/v1/collection/add_tokens (multipart collectionID + CSV) x${Math.ceil(rows.length / a.csvBatch)} batches of <=${a.csvBatch} rows`);
  } else {
    const bal = await nft(apiKey, NFT_API, "GET", "/api/v1/user/get_balance");
    log(`  balance: ${JSON.stringify(bal)}`);
    let list = await nft(apiKey, NFT_API, "GET", "/api/v1/collection/list_collections");
    let cid = findCollectionId(list, a.collectionName, a.contract);
    if (!cid) {
      const res = await nft(apiKey, NFT_API, "POST", "/api/v1/collection/create_collection",
        JSON.stringify({ collectionName: a.collectionName, contractAddress: a.contract, chainID: a.chainId, network: a.network }),
        { "Content-Type": "application/json" });
      log(`  create_collection: ${JSON.stringify(res)}`);
      list = await nft(apiKey, NFT_API, "GET", "/api/v1/collection/list_collections");
      cid = findCollectionId(list, a.collectionName, a.contract);
    }
    if (!cid) throw new Error(`could not find collection id in ${JSON.stringify(list).slice(0, 500)}`);
    log(`  collectionID ${cid}`);
    const [r0, r1] = a.rows ?? [1, rows.length];
    const sel = rows.slice(r0 - 1, r1);
    log(`  sending data rows ${r0}-${r1} (${sel.length} rows)`);
    for (let i = 0; i < sel.length; i += a.csvBatch) {
      const part = ["tokenAddress,cid", ...sel.slice(i, i + a.csvBatch)].join("\n") + "\n";
      const fd = new FormData();
      fd.append("collectionID", String(cid));
      fd.append("network", a.network);
      fd.append("file", new Blob([part], { type: "text/csv" }), `gcat-${i / a.csvBatch + 1}.csv`);
      const res = await nft(apiKey, NFT_API, "POST", "/api/v1/collection/add_tokens", fd);
      log(`  add_tokens rows ${r0 + i}-${r0 + Math.min(i + a.csvBatch, sel.length) - 1}: ${JSON.stringify(res)}`);
    }
    manifest.nftstorageCollectionId = cid;
    fs.writeFileSync(path.join(STAGE, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    // promote staged metadata to the canonical out/metadata now that the CIDs are final
    if (a.promote && !a.rows) {
      fs.cpSync(STAGE_MD, path.join(OUT, "metadata"), { recursive: true });
      log("  copied staged metadata -> out/metadata (canonical)");
    } else log("  --no-promote: out/metadata left unchanged (staged copy in out/ipfs/metadata)");
  }

  step("6/6 results");
  log(`  IMAGES_CID   ${imagesCid}   image base   ipfs://${imagesCid}/`);
  log(`  METADATA_CID ${metadataCid}   METADATA_BASE_URI for initialize_collection: ipfs://${metadataCid}/`);
  log("  gateway test URLs:");
  for (const id of SPOT) {
    log(`    #${id} image    ${a.gateway}${imagesCid}/${id}.webp   |   https://${imagesCid}.ipfs.dweb.link/${id}.webp`);
    log(`    #${id} metadata ${a.gateway}${metadataCid}/${id}.json   |   https://${metadataCid}.ipfs.dweb.link/${id}.json`);
  }
  if (a.dryRun) log("\n  DRY RUN complete: nothing was uploaded and no network calls were made. These CIDs are final; a live run reproduces them byte-for-byte.");
  else log("\n  Next: wait for NFT.Storage dashboard status = Complete for all rows (keep the Kubo node online until then),\n  then verify the URLs above + Phantom, then run initialize_collection with METADATA_BASE_URI.");
  log(`  elapsed ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((e) => { console.error(`\nERROR: ${e.message}`); process.exit(1); });
