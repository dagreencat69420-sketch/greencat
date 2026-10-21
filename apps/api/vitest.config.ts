import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: { "@greencat/sdk": path.resolve(__dirname, "../../packages/sdk/src/index.ts") },
  },
  test: { include: ["test/**/*.test.ts"], testTimeout: 30_000 },
});
