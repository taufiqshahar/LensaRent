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
        // Tests build their bindings with TEST_ENV (test/helpers.ts) and call the app directly;
        // these only matter for code that reads the Worker's own env.
        bindings: {
          ENVIRONMENT: "test",
          FIREBASE_PROJECT_ID: "demo-lensarent",
          // Fixed ports from firebase/firebase.json; integration tests need `pnpm test:emulator`.
          FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
          FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
