import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/node_modules/**", "**/dist/**", "**/coverage/**", "**/.wrangler/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      eqeqeq: ["error", "always"],
      // Project bans (master prompt §2, §8): no date libraries, no Node Admin SDK in the Worker.
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "moment", message: "Use Date + Intl via @lensarent/shared time helpers." },
            { name: "dayjs", message: "Use Date + Intl via @lensarent/shared time helpers." },
            {
              name: "firebase-admin",
              message: "Not compatible with Workers. Use apps/worker/src/lib/firestore.ts (REST).",
            },
          ],
        },
      ],
    },
  },
  {
    // The browser must never build HTML from data (XSS). Use textContent / DOM APIs.
    files: ["apps/web/**/*.ts"],
    rules: {
      "no-restricted-properties": [
        "error",
        { property: "innerHTML", message: "Use textContent or DOM APIs (master prompt §8)." },
        { property: "outerHTML", message: "Use textContent or DOM APIs (master prompt §8)." },
        { property: "insertAdjacentHTML", message: "Use DOM APIs (master prompt §8)." },
      ],
    },
  },
  {
    files: ["**/*.test.ts", "**/test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
  {
    files: ["**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  prettier,
);
