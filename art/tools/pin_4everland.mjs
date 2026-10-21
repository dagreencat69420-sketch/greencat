#!/usr/bin/env node
// 4EVER Pin (IPFS Pinning Services API) helper. Token from env FOREVERLAND_PIN_TOKEN (never printed).
// usage: node pin_4everland.mjs list | add <cid> <name> [origin...] | get <requestid>
const API = process.env.FOREVERLAND_PIN_API || "https://api.4everland.dev";
const tok = process.env.FOREVERLAND_PIN_TOKEN?.trim();
if (!tok) { console.error("FOREVERLAND_PIN_TOKEN not set"); process.exit(2); }
const H = { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" };
const [cmd, ...a] = process.argv.slice(2);
async function call(method, p, body) {
  const r = await fetch(API + p, { method, headers: H, body: body && JSON.stringify(body) });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, body: j };
}
let res;
if (cmd === "list") res = await call("GET", "/pins?limit=50&status=queued,pinning,pinned,failed");
else if (cmd === "add") res = await call("POST", "/pins", { cid: a[0], name: a[1], origins: a.slice(2) });
else if (cmd === "get") res = await call("GET", `/pins/${a[0]}`);
else { console.error("usage: list | add <cid> <name> [origins] | get <requestid>"); process.exit(2); }
console.log(JSON.stringify(res, null, 1).replaceAll(tok, "***"));
