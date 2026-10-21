#!/usr/bin/env node
// Minimal NFT.Storage (preserve) API helper. Key from env NFT_STORAGE_API_KEY (never printed).
// usage: balance | collections | tokens <collectionID> [lastKey] | status <collectionID>  (all pages, counts by status)
//        deal <cid> | create <name> <contract> <chainID> <network> | add <collectionID> <csvPath>
import fs from "node:fs";
const API = process.env.NFTSTORAGE_API || "https://preserve.nft.storage";
const key = process.env.NFT_STORAGE_API_KEY?.trim();
if (!key) { console.error("NFT_STORAGE_API_KEY not set"); process.exit(2); }
const scrub = (s) => s.replaceAll(key, "***");
async function call(method, p, body, headers = {}) {
  const r = await fetch(API + p, { method, body, headers: { Authorization: `Bearer ${key}`, ...headers } });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, body: j };
}
const [cmd, ...a] = process.argv.slice(2);
let res;
if (cmd === "balance") res = await call("GET", "/api/v1/user/get_balance");
else if (cmd === "collections") res = await call("GET", "/api/v1/collection/list_collections");
else if (cmd === "tokens") res = await call("GET", `/api/v1/collection/list_tokens?collectionID=${encodeURIComponent(a[0])}${a[1] ? `&lastKey=${encodeURIComponent(a[1])}` : ""}`);
else if (cmd === "deal") res = await call("GET", `/api/v1/collection/deal_status?cid=${a[0]}`);
else if (cmd === "create") res = await call("POST", "/api/v1/collection/create_collection",
  JSON.stringify({ collectionName: a[0], contractAddress: a[1], chainID: a[2], network: a[3] }), { "Content-Type": "application/json" });
else if (cmd === "add") {
  const fd = new FormData(); fd.append("collectionID", a[0]);
  fd.append("file", new Blob([fs.readFileSync(a[1])], { type: "text/csv" }), a[1].split("/").pop());
  res = await call("POST", "/api/v1/collection/add_tokens", fd);
} else if (cmd === "status") {
  // the live API pages with pageNumber (as the dashboard does); `lastKey` from the docs is rejected
  const counts = {}; let n = 0, pages = 0, sample; const seen = new Set();
  for (let page = 1; page < 200; page++) {
    const r = await call("GET", `/api/v1/collection/list_tokens?collectionID=${encodeURIComponent(a[0])}&pageNumber=${page}`);
    if (r.status !== 200) { res = r; break; }
    const b = r.body; const arr = Array.isArray(b?.value) ? b.value : b?.value?.data ?? b?.value?.tokens ?? [];
    if (page === 1 && !Array.isArray(b?.value)) sample = Object.keys(b?.value ?? {});
    let fresh = 0;
    for (const t of arr) { if (seen.has(t.id)) continue; seen.add(t.id); fresh++; const s = t.dealStatus ?? "?"; counts[s] = (counts[s] || 0) + 1; n++; }
    pages++;
    if (!arr.length || !fresh) break;
  }
  res ??= { total: n, pages, counts, shape: sample };
} else { console.error("bad cmd"); process.exit(2); }
console.log(scrub(JSON.stringify(res, null, 1)));
