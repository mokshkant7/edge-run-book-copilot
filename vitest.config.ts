import { defineConfig } from "vitest/config";

// Unit tests cover pure logic (retrieval, approval policy, quota rules).
// Workers-runtime behaviour is covered end to end by scripts/e2e.mjs against `wrangler dev`.
export default defineConfig({
  test: { environment: "node", include: ["test/**/*.test.ts"] },
});
