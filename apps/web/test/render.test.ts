import { describe, expect, it } from "vitest";
import { pages } from "../src/pages/index.ts";
import { collectedDrafts } from "../src/render/drafts.ts";
import { escapeHtml, html, trusted } from "../src/render/html.ts";

// Prettier reformats templates tagged `html`; an alias keeps the expected markup exact.
const h = html;
import type { BuildContext } from "../src/render/layout.ts";
import { renderDocument } from "../src/render/layout.ts";

const staging: BuildContext = {
  mode: "staging",
  siteOrigin: undefined,
  turnstileSiteKey: "1x00000000000000000000AA",
};
const production: BuildContext = {
  mode: "production",
  siteOrigin: "https://lensarent.example",
  turnstileSiteKey: "0x4AAAAAAAreal",
};

describe("html templates", () => {
  it("escape every interpolated value", () => {
    const name = `<img src=x onerror="alert('x')">&`;
    expect(html`<p title="${name}">${name}</p>`.value).toBe(
      '<p title="&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;">&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;</p>',
    );
  });

  it("nest templates and lists without double escaping", () => {
    const items = ["a<b", "c"];
    expect(h`<ul>${items.map((item) => h`<li>${item}</li>`)}</ul>`.value).toBe(
      "<ul><li>a&lt;b</li><li>c</li></ul>",
    );
  });

  it("drop null, undefined and booleans", () => {
    expect(html`[${null}${undefined}${false}${true}${0}]`.value).toBe("[0]");
  });

  it("pass trusted markup through untouched", () => {
    expect(html`${trusted("<b>x</b>")}`.value).toBe("<b>x</b>");
    expect(escapeHtml("\"'")).toBe("&quot;&#39;");
  });
});

describe("pages", () => {
  const byEntry = (entry: string) => {
    const page = pages.find((candidate) => candidate.entry === entry);
    if (!page) throw new Error(entry);
    return page;
  };

  it("render every page as a complete Malay document", () => {
    for (const page of pages) {
      const doc = renderDocument(page, staging, () => true);
      expect(doc.startsWith("<!doctype html>"), page.entry).toBe(true);
      expect(doc).toContain('<html lang="ms">');
      expect(doc).toContain("<title>");
      expect(doc).toContain('<main id="kandungan">');
    }
  });

  it("keep staging out of search engines and mark it as a draft", () => {
    const doc = renderDocument(byEntry("index"), staging, () => true);
    expect(doc).toContain('<meta name="robots" content="noindex" />');
    expect(doc).toContain("DRAF — sebahagian kandungan");
    expect(doc).not.toContain('rel="canonical"');
  });

  it("let production pages be indexed, with canonical URLs", () => {
    const doc = renderDocument(byEntry("terma"), production, () => false);
    expect(doc).not.toContain('name="robots"');
    expect(doc).toContain('<link rel="canonical" href="https://lensarent.example/terma" />');
    expect(doc).not.toContain("DRAF — sebahagian kandungan");
  });

  it("never index the admin or 404 pages, even in production", () => {
    for (const entry of ["admin/index", "404"]) {
      expect(renderDocument(byEntry(entry), production, () => false)).toContain(
        '<meta name="robots" content="noindex" />',
      );
    }
  });

  it("carry the Turnstile site key and the settings' prices", () => {
    const doc = renderDocument(byEntry("index"), staging, () => true);
    expect(doc).toContain('data-sitekey="1x00000000000000000000AA"');
    expect(doc).toContain("RM69");
    expect(doc).toContain("Deposit RM100");
  });

  it("list what still needs confirming", () => {
    for (const page of pages) renderDocument(page, staging, () => true);
    expect(collectedDrafts()).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Spesifikasi"),
        expect.stringContaining("Maklumat perniagaan"),
        expect.stringContaining("Notis privasi"),
        expect.stringContaining("Terma"),
      ]),
    );
  });
});
