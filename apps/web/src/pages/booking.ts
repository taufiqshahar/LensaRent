import {
  addOns,
  brand,
  cancellation,
  deposit,
  filterBase,
  locations,
  maxDays,
  minLeadHours,
  rm,
  whatsappGeneral,
} from "../content/facts";
import type { SafeHtml } from "../render/html";
import { html } from "../render/html";
import type { BuildContext, Page } from "../render/layout";

/**
 * /tempah (the booking form) and /tempahan (a booking's status). Both pages are static
 * shells; src/booking.ts and src/status.ts fill them from the API. Locations and add-ons
 * come from the settings at build time; handover slots are fetched at run time because
 * the admin can change them without a deploy.
 */

function error(id: string): SafeHtml {
  return html`<p class="field__error" id="${id}-error" hidden></p>`;
}

function locationSelect(id: string, label: string): SafeHtml {
  return html`<div class="field">
    <label for="${id}">${label}</label>
    <select id="${id}" name="${id}" required aria-describedby="${id}-error">
      ${locations.map(
        (location) =>
          html`<option value="${location.id}">
            ${location.name}${location.feeSen > 0 ? ` (+${rm(location.feeSen)})` : ""}
          </option>`,
      )}
    </select>
    ${error(id)}
  </div>`;
}

function leg(kind: "pickup" | "return", title: string): SafeHtml {
  return html`<fieldset class="booking__leg">
    <legend>${title}</legend>
    <div class="field">
      <label for="${kind}Date">Tarikh</label>
      <input
        id="${kind}Date"
        name="${kind}Date"
        type="date"
        required
        aria-describedby="${kind}Date-error"
      />
      ${error(`${kind}Date`)}
    </div>
    <div class="field">
      <label for="${kind}SlotId">Slot masa</label>
      <select
        id="${kind}SlotId"
        name="${kind}SlotId"
        required
        aria-describedby="${kind}SlotId-error"
      >
        <option value="">Pilih tarikh dahulu</option>
      </select>
      ${error(`${kind}SlotId`)}
    </div>
    ${locationSelect(`${kind}LocationId`, "Lokasi")}
  </fieldset>`;
}

function bookingForm(context: BuildContext): SafeHtml {
  return html`<section class="section">
    <div class="container narrow">
      <h1>Tempah DJI Osmo Pocket 4P</h1>
      <p>
        Pilih tarikh dan slot serahan, semak harga, kemudian bayar dalam talian. Tempahan minimum
        ${minLeadHours} jam lebih awal, maksimum ${maxDays} hari. Deposit ${deposit} dipulangkan
        selepas pemeriksaan.
      </p>
      <div class="card notice" id="booking-closed" hidden role="status">
        <p>
          Tempahan dalam talian belum dibuka. Sila
          <a href="${whatsappGeneral}">WhatsApp kami</a> untuk menempah.
        </p>
      </div>
      <form
        class="booking card"
        id="booking-form"
        novalidate
        hidden
        data-sitekey="${context.turnstileSiteKey}"
      >
        ${leg("pickup", "1. Ambil")} ${leg("return", "2. Pulang")}
        <fieldset class="booking__leg">
          <legend>3. Tambahan</legend>
          ${addOns.map(
            (item) =>
              html`<label class="check">
                <input type="checkbox" name="addon" value="${item.code}" />
                <span>${item.name} (+${rm(item.priceSen)})</span>
              </label>`,
          )}
          <p class="muted small">Penapis lensa disertakan dengan ${filterBase} tanpa caj.</p>
          ${error("addOns")}
        </fieldset>

        <section class="booking__quote" id="quote" aria-live="polite">
          <h2>Ringkasan harga</h2>
          <p class="muted" id="quote-status">Pilih tarikh dan slot untuk melihat harga.</p>
          <dl class="calculator__result" id="quote-lines" hidden>
            <div>
              <dt>Sewa</dt>
              <dd data-out="rental"></dd>
            </div>
            <div>
              <dt>Tambahan</dt>
              <dd data-out="addons"></dd>
            </div>
            <div>
              <dt>Caj lokasi</dt>
              <dd data-out="meetup"></dd>
            </div>
            <div>
              <dt>Deposit (dipulangkan)</dt>
              <dd data-out="deposit"></dd>
            </div>
            <div class="calculator__total">
              <dt>Jumlah dibayar</dt>
              <dd data-out="total"></dd>
            </div>
          </dl>
        </section>

        <fieldset class="booking__leg">
          <legend>4. Maklumat anda</legend>
          <div class="field">
            <label for="name">Nama penuh</label>
            <input
              id="name"
              name="name"
              autocomplete="name"
              required
              minlength="2"
              maxlength="80"
              aria-describedby="name-error"
            />
            ${error("name")}
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
            ${error("phone")}
          </div>
          <div class="field">
            <label for="email">Emel (untuk resit)</label>
            <input
              id="email"
              name="email"
              type="email"
              autocomplete="email"
              required
              maxlength="254"
              aria-describedby="email-error"
            />
            ${error("email")}
          </div>
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
                >Saya telah membaca dan bersetuju dengan <a href="/terma">terma &amp; syarat</a>,
                <a href="/polisi">polisi sewaan</a> (termasuk polisi pembatalan: bayaran balik penuh
                jika dibatalkan lebih ${cancellation.fullAbove} jam sebelum ambil) dan
                <a href="/privasi">notis privasi</a> ${brand}.</span
              >
            </label>
            ${error("consent")}
          </div>
        </fieldset>

        <div class="turnstile" id="turnstile"></div>
        ${error("turnstileToken")}
        <button class="button button--block" type="submit">Tahan tarikh &amp; bayar</button>
        <p class="form-status" id="booking-status" role="status" aria-live="polite"></p>
        <p class="muted small">
          Tarikh anda ditahan untuk tempoh yang terhad sementara anda membayar melalui CHIP (FPX,
          kad atau e-dompet). Jika bayaran tidak selesai, tarikh dilepaskan secara automatik.
        </p>
      </form>
      <noscript>
        <p>
          Borang tempahan memerlukan JavaScript. Anda juga boleh
          <a href="${whatsappGeneral}">WhatsApp kami</a>.
        </p>
      </noscript>
    </div>
  </section>`;
}

export const bookingPage: Page = {
  entry: "tempah",
  path: "/tempah",
  title: "Tempah",
  description: `Tempah DJI Osmo Pocket 4P dalam talian dengan ${brand}: pilih tarikh, slot dan bayar.`,
  script: "/src/booking.ts",
  body: bookingForm,
};

export const statusPage: Page = {
  entry: "tempahan",
  path: "/tempahan",
  title: "Status tempahan",
  description: `Status tempahan ${brand} anda.`,
  noindex: true,
  hidden: true,
  script: "/src/status.ts",
  body: () =>
    html`<section class="section">
      <div class="container narrow">
        <h1>Status tempahan</h1>
        <div id="status-app" aria-live="polite">
          <p class="muted">Memuatkan…</p>
        </div>
        <noscript><p>Halaman ini memerlukan JavaScript.</p></noscript>
        <p class="muted small">Ada soalan? <a href="${whatsappGeneral}">WhatsApp kami</a>.</p>
      </div>
    </section>`,
};
