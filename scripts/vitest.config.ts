import { defineConfig } from "vitest/config";

// Needs the Auth and Firestore emulators: `pnpm test:emulator`.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"], testTimeout: 30_000 },
});
