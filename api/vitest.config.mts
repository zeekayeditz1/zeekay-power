import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      // A local-only config prevents tests from ever reaching production D1.
      wrangler: { configPath: "./wrangler.test.jsonc" },
    }),
  ],
});
