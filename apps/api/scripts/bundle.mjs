// Bundle server + worker to dist/ (SDK TS source inlined; npm deps stay external).
import { build } from "esbuild";
import fs from "node:fs";

await build({
  entryPoints: ["src/server.ts", "src/worker.ts", "src/migrate.ts"],
  outdir: "dist",
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  sourcemap: true,
  packages: "external",
  // @greencat/sdk is TS source in the monorepo → must be bundled, not external
  plugins: [
    {
      name: "inline-sdk",
      setup(b) {
        b.onResolve({ filter: /^@greencat\/sdk$/ }, () => ({
          path: new URL("../../../packages/sdk/src/index.ts", import.meta.url).pathname,
        }));
      },
    },
  ],
  banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
});
// migrations are read at runtime relative to dist/../migrations
fs.mkdirSync("dist", { recursive: true });
console.log("[bundle] dist/server.js dist/worker.js dist/migrate.js");
