import {
  LEAD_SOURCES,
  LEAD_SOURCE_LABELS,
  LEAD_USAGES,
  LEAD_USAGE_LABELS,
} from "../render/shared.ts";
import {
  addOns,
  brand,
  cancellation,
  deposit,
  filterBase,
  fromPrice,
  lateFee,
  maxDays,
  priceRows,
  rm,
  whatsappGeneral,
} from "../content/facts";
import {
  areaLine,
  faqs,
  kit,
  meetupNote,
  optionalKit,
  slotsNote,
  specs,
  steps,
} from "../content/site";
import type { SafeHtml } from "../render/html";
import { html } from "../render/html";
import type { BuildContext, Page } from "../render/layout";

export function faqList(): SafeHtml {
  return html`<div class="faq">
    ${faqs.map(
      (faq) =>
        html`<details class="faq__item">
          <summary>${faq.question}</summary>
          <p>${faq.answer}</p>
        </details>`,
    )}
  </div>`;
}

function hero(): SafeHtml {
  return html`<section class="hero" aria-labelledby="hero-title">
    <div class="container hero__inner">
      <p class="eyebrow">Sewa kamera · ${areaLine}</p>
      <h1 id="hero-title">Sewa DJI Osmo Pocket 4P untuk vlog, percutian dan majlis anda</h1>
      <p class="hero__lead">
        Kamera gimbal poket yang ringkas dan stabil. Mulai <strong>${fromPrice} sehari</strong>,
        dengan deposit ${deposit} yang dipulangkan.
      </p>
      <div class="hero__actions">
        <a class="button" href="#semak">Semak tarikh</a>
        <a class="button button--ghost" href="${whatsappGeneral}" rel="noopener">WhatsApp kami</a>
      </div>
    </div>
  </section>`;
}

function specsSection(): SafeHtml {
  return html`<section class="section" aria-labelledby="spesifikasi">
    <div class="container">
      <h2 id="spesifikasi">Kenapa Pocket 4P</h2>
      <ul class="cards">
        ${specs.map(
          (spec) =>
            html`<li class="card">
              <h3>${spec.title}</h3>
              <p>${spec.text}</p>
            </li>`,
        )}
      </ul>
    </div>
  </section>`;
}

function kitSection(): SafeHtml {
  return html`<section class="section section--alt" aria-labelledby="kit">
    <div class="container">
      <h2 id="kit">Apa yang anda terima</h2>
      <ul class="checklist">
        ${kit.map((item) => html`<li>${item}</li>`)}
      </ul>
      ${
        optionalKit.length > 0
          ? html`<p class="muted">
              Pilihan tambahan: ${optionalKit.join(", ")}. ${filterBase} disertakan percuma bersama
              mana-mana penapis lensa.
            </p>`
          : null
      }
    </div>
  </section>`;
}

function pricingSection(): SafeHtml {
  return html`<section class="section" aria-labelledby="harga" id="harga">
    <div class="container pricing">
      <div>
        <h2>Harga</h2>
        <table class="price-table">
          <caption class="visually-hidden">
            Harga sewa mengikut tempoh
          </caption>
          <thead>
            <tr>
              <th scope="col">Tempoh</th>
              <th scope="col">Harga sewa</th>
            </tr>
          </thead>
          <tbody>
            ${priceRows.map(
              (row) =>
                html`<tr>
                  <th scope="row">${row.label}</th>
                  <td>${row.price}</td>
                </tr>`,
            )}
          </tbody>
        </table>
        <p class="deposit-note">
          <strong>Deposit ${deposit}</strong> dibayar berasingan dan dipulangkan selepas pemeriksaan
          unit. Deposit bukan sebahagian daripada harga sewa.
        </p>
        ${
          addOns.length > 0
            ? html`<p class="muted">
                Aksesori: ${addOns.map((item) => `${item.name} ${rm(item.priceSen)}`).join(" · ")}
                (sekali bayar setiap tempahan).
              </p>`
            : null
        }
        <p class="muted">${meetupNote}</p>
      </div>

      <form class="calculator card" id="kalkulator" aria-labelledby="kalkulator-title">
        <h3 id="kalkulator-title">Kira anggaran</h3>
        <label for="calc-days">Bilangan hari</label>
        <select id="calc-days" name="days">
          ${Array.from({ length: maxDays }, (_, index) => {
            const days = (index + 1).toString();
            return html`<option value="${days}">${days} hari</option>`;
          })}
        </select>
        ${
          addOns.length > 0
            ? html`<fieldset>
                <legend>Aksesori</legend>
                ${addOns.map(
                  (item) =>
                    html`<label class="check">
                      <input type="checkbox" name="addon" value="${item.code}" />
                      ${item.name} (${rm(item.priceSen)})
                    </label>`,
                )}
              </fieldset>`
            : null
        }
        <dl class="calculator__result" aria-live="polite">
          <div>
            <dt>Sewa</dt>
            <dd data-out="rental">${fromPrice}</dd>
          </div>
          <div>
            <dt>Aksesori</dt>
            <dd data-out="addons">RM0</dd>
          </div>
          <div class="calculator__total">
            <dt>Jumlah sewa</dt>
            <dd data-out="charges">${fromPrice}</dd>
          </div>
          <div>
            <dt>Deposit (dipulangkan)</dt>
            <dd data-out="deposit">${deposit}</dd>
          </div>
          <div class="calculator__total">
            <dt>Jumlah dibayar</dt>
            <dd data-out="total"></dd>
          </div>
        </dl>
        <p class="muted small">Anggaran sahaja. Jumlah muktamad disahkan semasa tempahan.</p>
      </form>
    </div>
  </section>`;
}

function stepsSection(): SafeHtml {
  return html`<section class="section section--alt" aria-labelledby="cara-tempah" id="cara-tempah">
    <div class="container">
      <h2>Cara tempah</h2>
      <ol class="steps">
        ${steps.map(
          (step) =>
            html`<li class="steps__item">
              <h3>${step.title}</h3>
              <p>${step.text}</p>
            </li>`,
        )}
      </ol>
      <p class="muted">${slotsNote}</p>
    </div>
  </section>`;
}

function policySection(): SafeHtml {
  return html`<section class="section" aria-labelledby="polisi-ringkas">
    <div class="container">
      <h2 id="polisi-ringkas">Polisi ringkas</h2>
      <ul class="cards">
        <li class="card">
          <h3>Deposit</h3>
          <p>${deposit}, dipulangkan melalui DuitNow selepas unit diperiksa.</p>
        </li>
        <li class="card">
          <h3>Pembatalan</h3>
          <p>
            Lebih ${cancellation.fullAbove.toString()} jam sebelum ambil: bayaran balik penuh. Lebih
            dekat dari itu, caj ${cancellation.fee} mungkin dikenakan.
          </p>
        </li>
        <li class="card">
          <h3>Lewat pulang</h3>
          <p>
            Tempoh ihsan ${lateFee.grace.toString()} minit, kemudian ${lateFee.perBlock} setiap
            ${lateFee.blockHours.toString()} jam.
          </p>
        </li>
      </ul>
      <p><a href="/polisi">Baca polisi sewaan penuh</a></p>
    </div>
  </section>`;
}

function reviewsSection(): SafeHtml {
  // Real reviews only. Never invent testimonials.
  return html`<section class="section section--alt" aria-labelledby="ulasan">
    <div class="container">
      <h2 id="ulasan">Ulasan pelanggan</h2>
      <p class="muted">
        Kami baru bermula, jadi belum ada ulasan lagi. Ulasan pelanggan sebenar akan dipaparkan di
        sini.
      </p>
    </div>
  </section>`;
}

function select(
  id: string,
  label: string,
  values: readonly string[],
  labels: Readonly<Record<string, string>>,
): SafeHtml {
  return html`<div class="field">
    <label for="${id}">${label}</label>
    <select id="${id}" name="${id}" required aria-describedby="${id}-error">
      <option value="">Sila pilih</option>
      ${values.map((value) => html`<option value="${value}">${labels[value] ?? value}</option>`)}
    </select>
    <p class="field__error" id="${id}-error" hidden></p>
  </div>`;
}

function leadForm(context: BuildContext): SafeHtml {
  return html`<section class="section section--brand" aria-labelledby="semak-title" id="semak">
    <div class="container narrow">
      <h2 id="semak-title">Semak tarikh</h2>
      <p>
        Beritahu kami tarikh yang anda mahu. Kami akan sahkan ketersediaan melalui WhatsApp,
        biasanya pada hari yang sama.
      </p>
      <form
        class="lead-form card"
        id="lead-form"
        novalidate
        data-sitekey="${context.turnstileSiteKey}"
      >
        <div class="field">
          <label for="name">Nama</label>
          <input
            id="name"
            name="name"
            autocomplete="name"
            required
            minlength="2"
            maxlength="80"
            aria-describedby="name-error"
          />
          <p class="field__error" id="name-error" hidden></p>
        </div>
        <div class="field">
          <label for="phone">No. telefon bimbit (WhatsApp)</label>
          <input
            id="phone"
            name="phone"
            type="tel"
            inputmode="tel"
            autocomplete="tel"
            placeholder="012-345 6789"
            required
            maxlength="20"
            aria-describedby="phone-error"
          />
          <p class="field__error" id="phone-error" hidden></p>
        </div>
        <div class="field">
          <label for="desiredDate">Tarikh diingini <span class="muted">(tidak wajib)</span></label>
          <input
            id="desiredDate"
            name="desiredDate"
            type="date"
            aria-describedby="desiredDate-error"
          />
          <p class="field__error" id="desiredDate-error" hidden></p>
        </div>
        ${select("usage", "Untuk apa?", LEAD_USAGES, LEAD_USAGE_LABELS)}
        ${select("source", "Dari mana anda tahu tentang kami?", LEAD_SOURCES, LEAD_SOURCE_LABELS)}
        <div class="field">
          <label class="check">
            <input
              id="consent"
              name="consent"
              type="checkbox"
              required
              aria-describedby="consent-error"
            />
            <span
              >Saya bersetuju ${brand} menghubungi saya melalui WhatsApp dan memproses maklumat ini
              mengikut <a href="/privasi">notis privasi</a>.</span
            >
          </label>
          <p class="field__error" id="consent-error" hidden></p>
        </div>
        <div class="turnstile" id="turnstile"></div>
        <p class="field__error" id="turnstileToken-error" hidden></p>
        <button class="button button--block" type="submit">Hantar</button>
        <p class="form-status" id="lead-status" role="status" aria-live="polite"></p>
      </form>
      <noscript>
        <p>
          Borang ini memerlukan JavaScript. Anda juga boleh
          <a href="${whatsappGeneral}">WhatsApp kami terus</a>.
        </p>
      </noscript>
      <p class="muted">
        Lebih suka bercakap terus? <a href="${whatsappGeneral}" rel="noopener">WhatsApp kami</a>.
      </p>
    </div>
  </section>`;
}

function faqSection(): SafeHtml {
  return html`<section class="section" aria-labelledby="soalan">
    <div class="container narrow">
      <h2 id="soalan">Soalan lazim</h2>
      ${faqList()}
      <p><a href="/soalan-lazim">Lihat semua soalan</a></p>
    </div>
  </section>`;
}

/** The landing page, in the order of master prompt §11. */
export const landingPage: Page = {
  entry: "index",
  path: "/",
  title: `Sewa DJI Osmo Pocket 4P · ${areaLine} | ${brand}`,
  description: `Sewa kamera DJI Osmo Pocket 4P di ${areaLine}. Mulai ${fromPrice} sehari, deposit ${deposit} dipulangkan. Semak tarikh sekarang.`,
  script: "/src/main.ts",
  body: (context) =>
    html`${hero()} ${/* Section 2, demo video: added once a real video exists. */ null}
    ${specsSection()} ${kitSection()} ${pricingSection()} ${stepsSection()} ${leadForm(context)}
    ${policySection()} ${reviewsSection()} ${faqSection()}`,
};
