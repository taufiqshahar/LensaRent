import { defineConfig } from "vitest/config";

// Security Rules tests. They need the Firestore and Storage emulators: `pnpm test:emulator`.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
