// Read-only parity dump: imports the demo catalog + SDK catalog (no modification) and writes
// token_id -> rarity (+ demo traits) so the Python art pipeline can be verified against it.
import * as demo from "/workspace/greencat-holder-app/src/lib/nftCatalog.ts";
import * as sdk from "../../packages/sdk/src/nftCatalog.ts";
import fs from "node:fs";
const out: any[] = [];
let mismatch = 0;
for (let id = 1; id <= demo.COLLECTION_SIZE; id++) {
  const r = demo.getTokenRarity(id);
  if (sdk.getTokenRarity(id) !== r) mismatch++;
  const t = demo.getTokenTraits(id);
  out.push({ id, rarity: r, catchphrase: t.catchphrase, hat: t.hat, accessory: t.accessory, eyes: t.eyes, fur: t.fur, background: t.background });
}
fs.writeFileSync(process.argv[2], JSON.stringify(out));
console.log("demo-vs-sdk rarity mismatches:", mismatch);
