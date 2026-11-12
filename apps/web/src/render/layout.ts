import { brand, phoneDisplay, settings, whatsappGeneral } from "../content/facts";
import { draft } from "./drafts";
import type { SafeHtml } from "./html";
import { html, trusted } from "./html";

export interface BuildContext {
  mode: "development" | "staging" | "production";
  /** e.g. https://lensarent.my — required for production (canonical URLs, sitemap). */
  siteOrigin: string | undefined;
  turnstileSiteKey: string;
}

export interface Page {
  /** Entry file name without extension, e.g. `index`, `terma`, `admin/index`. */
  entry: string;
  /** Public URL path, e.g. `/`, `/terma`. */
  path: string;
  title: string;
  description: string;
  body: (context: BuildContext) => SafeHtml;
  /** Module script for this page, relative to the web root. */
  script?: string;
  /** Kept out of search results (admin, 404). Staging is always noindex. */
  noindex?: boolean;
  /** Excluded from the sitemap. */
  hidden?: boolean;
  /** No site header/footer (admin). */
  bare?: boolean;
}

const business = settings.businessInfo;

function businessDetails(): SafeHtml {
  const confirmed =
    business.legalName !== "" && business.ssmNumber !== "" && business.address !== "";
  const details = confirmed
    ? business
    : draft("Maklumat perniagaan untuk footer (nama berdaftar, SSM, alamat, emel)", {
        ...business,
        legalName: business.legalName || "[Nama perniagaan berdaftar]",
        ssmNumber: business.ssmNumber || "[No. pendaftaran SSM]",
        address: business.address || "[Alamat perniagaan]",
        email: business.email || "[Emel perniagaan]",
      });
  return html`<address class="footer__business">
    <strong>${details.legalName}</strong> (${details.ssmNumber})<br />
    ${details.address}<br />
    Tel/WhatsApp: <a href="${whatsappGeneral}">${phoneDisplay}</a><br />
    Emel:
    ${details.email.startsWith("[") ? details.email : html`<a href="mailto:${details.email}">${details.email}</a>`}
  </address>`;
}

function header(): SafeHtml {
  return html`<header class="site-header">
    <div class="container site-header__inner">
      <a class="brand" href="/">${brand}</a>
      <nav aria-label="Utama">
        <ul class="nav">
          <li><a href="/#harga">Harga</a></li>
          <li><a href="/#cara-tempah">Cara tempah</a></li>
          <li><a href="/soalan-lazim">Soalan lazim</a></li>
          <li><a class="button button--small" href="/#semak">Semak tarikh</a></li>
        </ul>
      </nav>
    </div>
  </header>`;
}

function footer(): SafeHtml {
  const year = new Date().getFullYear().toString();
  return html`<footer class="site-footer">
    <div class="container footer__grid">
      ${businessDetails()}
      <nav aria-label="Polisi">
        <ul class="footer__links">
          <li><a href="/terma">Terma &amp; syarat</a></li>
          <li><a href="/privasi">Notis privasi</a></li>
          <li><a href="/polisi">Polisi sewaan</a></li>
          <li><a href="/panduan">Panduan sewaan</a></li>
          <li><a href="/soalan-lazim">Soalan lazim</a></li>
        </ul>
      </nav>
    </div>
    <p class="container footer__copy">
      © ${year} ${brand}. Semua harga dalam Ringgit Malaysia (RM).
    </p>
  </footer>`;
}

function draftBanner(): SafeHtml {
  return html`<div class="draft-banner" role="note">
    DRAF — sebahagian kandungan belum disahkan. Bukan untuk kegunaan awam.
  </div>`;
}

function localBusinessJsonLd(context: BuildContext): SafeHtml | null {
  if (!context.siteOrigin || business.address === "") return null;
  const data = {
    "@context": "https://schema.org",
    "@type": "LocalBusiness",
    name: brand,
    url: context.siteOrigin,
    telephone: business.phoneE164,
    address: business.address,
    areaServed: settings.meetupLocations.locations.map((location) => location.name),
  };
  // JSON.stringify output with "<" escaped cannot close the script element.
  return trusted(
    `<script type="application/ld+json">${JSON.stringify(data).replaceAll("<", "\\u003c")}</script>`,
  );
}

/** A complete HTML document for a page. */
export function renderDocument(
  page: Page,
  context: BuildContext,
  hasDrafts: () => boolean,
): string {
  const body = page.body(context);
  const noindex = page.noindex === true || context.mode !== "production";
  const canonical = context.siteOrigin ? `${context.siteOrigin}${page.path}` : null;
  const title = page.path === "/" ? page.title : `${page.title} — ${brand}`;

  const doc = html`<!doctype html>
<html lang="ms">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <meta name="description" content="${page.description}" />
    <meta name="theme-color" content="#0f766e" />
    ${noindex ? html`<meta name="robots" content="noindex" />` : null}
    ${canonical ? html`<link rel="canonical" href="${canonical}" />` : null}
    <meta property="og:type" content="website" />
    <meta property="og:locale" content="ms_MY" />
    <meta property="og:site_name" content="${brand}" />
    <meta property="og:title" content="${title}" />
    <meta property="og:description" content="${page.description}" />
    ${canonical ? html`<meta property="og:url" content="${canonical}" />` : null}
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="stylesheet" href="/src/styles.css" />
    ${page.path === "/" ? localBusinessJsonLd(context) : null}
    ${page.script ? html`<script type="module" src="${page.script}"></script>` : null}
  </head>
  <body${page.bare ? html` class="bare"` : null}>
    ${hasDrafts() && context.mode !== "production" ? draftBanner() : null}
    <a class="skip-link" href="#kandungan">Langkau ke kandungan</a>
    ${page.bare ? null : header()}
    <main id="kandungan">${body}</main>
    ${page.bare ? null : footer()}
  </body>
</html>
`;
  return doc.value;
}
