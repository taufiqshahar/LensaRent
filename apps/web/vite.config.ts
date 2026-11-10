import type { Plugin } from "vite";
import { defineConfig } from "vite";
import { isStringKey, t } from "./src/strings.bm.ts";

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Replaces {{t:key}} in HTML with the escaped string. An unknown key fails the build. */
function htmlStrings(): Plugin {
  return {
    name: "lensarent-html-strings",
    transformIndexHtml: {
      order: "pre",
      handler: (html) =>
        html.replace(/\{\{t:([A-Za-z0-9.]+)\}\}/g, (_match, key: string) => {
          if (!isStringKey(key)) throw new Error(`Unknown string key in HTML: ${key}`);
          return escapeHtml(t(key));
        }),
    },
  };
}

// A plain multi-page site: each HTML file is an entry. No UI framework.
export default defineConfig({
  plugins: [htmlStrings()],
  build: {
    target: "es2022",
    rollupOptions: {
      input: { index: "index.html", notFound: "404.html" },
    },
  },
});
