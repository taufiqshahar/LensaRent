import { relative } from "node:path";
import type { Plugin } from "vite";
import { defineConfig, loadEnv } from "vite";
import { pages } from "./src/pages/index.ts";
import { collectedDrafts } from "./src/render/drafts.ts";
import type { BuildContext, Page } from "./src/render/layout.ts";
import { renderDocument } from "./src/render/layout.ts";

/** Cloudflare's documented Turnstile test site keys (always pass / fail / interactive). */
const TEST_SITE_KEY = /^[123]x0{20}AA$/;
const DEFAULT_TEST_SITE_KEY = "1x00000000000000000000AA";

function buildContext(mode: string): BuildContext {
  if (mode !== "development" && mode !== "staging" && mode !== "production") {
    throw new Error(`Unknown build mode "${mode}". Use development, staging or production.`);
  }
  const env = loadEnv(mode, import.meta.dirname, "VITE_");
  const siteOrigin = env.VITE_SITE_ORIGIN?.replace(/\/$/, "") || undefined;
  return {
    mode,
    siteOrigin,
    turnstileSiteKey: env.VITE_TURNSTILE_SITE_KEY || DEFAULT_TEST_SITE_KEY,
  };
}

/** Problems that make a production build unsafe to publish. */
function productionProblems(context: BuildContext): string[] {
  const problems = collectedDrafts().map((label) => `Unconfirmed content: ${label}`);
  if (!context.siteOrigin?.startsWith("https://")) {
    problems.push("VITE_SITE_ORIGIN must be the https:// origin of the live site.");
  }
  if (TEST_SITE_KEY.test(context.turnstileSiteKey)) {
    problems.push("VITE_TURNSTILE_SITE_KEY is a Cloudflare test key; set the real site key.");
  }
  return problems;
}

function robots(context: BuildContext): string {
  if (context.mode !== "production" || !context.siteOrigin) {
    return "# Not the live site: keep everything out of search engines.\nUser-agent: *\nDisallow: /\n";
  }
  return `User-agent: *\nAllow: /\nDisallow: /admin/\nDisallow: /api/\n\nSitemap: ${context.siteOrigin}/sitemap.xml\n`;
}

function sitemap(context: BuildContext): string {
  const urls = pages
    .filter((page) => !page.hidden)
    .map((page) => `  <url><loc>${context.siteOrigin ?? ""}${page.path}</loc></url>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

/**
 * Generates every HTML page from src/pages at build time. Each `<entry>.html` file only
 * marks where a page lives; its whole content is replaced here.
 */
function sitePages(mode: string): Plugin {
  const context = buildContext(mode);
  const byEntry = new Map<string, Page>(pages.map((page) => [`${page.entry}.html`, page]));
  const hasDrafts = () => collectedDrafts().length > 0;

  return {
    name: "lensarent-site-pages",
    config: () => ({
      build: {
        rollupOptions: {
          input: Object.fromEntries(pages.map((page) => [page.entry, `${page.entry}.html`])),
        },
      },
    }),
    buildStart() {
      // Render everything once up front so every draft is known before anything is written.
      for (const page of pages) renderDocument(page, context, hasDrafts);
      if (context.mode === "production") {
        const problems = productionProblems(context);
        if (problems.length > 0) {
          this.error(`Production build refused:\n  - ${problems.join("\n  - ")}`);
        }
      } else if (hasDrafts()) {
        this.warn(
          `${collectedDrafts().length.toString()} draft item(s); pages show a DRAF banner.`,
        );
      }
    },
    transformIndexHtml: {
      order: "pre",
      handler: (_html, { filename }) => {
        const entry = relative(import.meta.dirname, filename).replaceAll("\\", "/");
        const page = byEntry.get(entry);
        if (!page) throw new Error(`No page is defined for ${entry}`);
        return renderDocument(page, context, hasDrafts);
      },
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "robots.txt", source: robots(context) });
      if (context.siteOrigin) {
        this.emitFile({ type: "asset", fileName: "sitemap.xml", source: sitemap(context) });
      }
    },
  };
}

// A plain multi-page site: no UI framework, no client-side routing.
export default defineConfig(({ mode }) => ({
  plugins: [sitePages(mode)],
  build: { target: "es2022" },
  server: {
    // `pnpm --filter @lensarent/web dev` for quick page work; the API runs on `wrangler dev`.
    proxy: { "/api": "http://127.0.0.1:8787" },
  },
}));
