import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Tests run inside workerd, the same runtime as production. The Worker is configured here
// rather than from wrangler.toml so tests do not depend on a built apps/web/dist.
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/index.ts",
      miniflare: {
        compatibilityDate: "2026-10-01",
        bindings: {
          ENVIRONMENT: "test",
          FIREBASE_PROJECT_ID: "demo-lensarent",
          // Fixed port from firebase/firebase.json; integration tests need `pnpm test:emulator`.
          FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
