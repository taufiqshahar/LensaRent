import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/index.ts"],
      reporter: ["text-summary", "text"],
      // Master prompt Fasa 0: packages/shared must stay at or above 90%.
      thresholds: { lines: 90, functions: 90, branches: 90, statements: 90 },
    },
  },
});
