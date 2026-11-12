import {
  brand,
  cancellation,
  deposit,
  filterBase,
  lateFee,
  maxDays,
  minLeadHours,
  phoneDisplay,
  policyVersions,
  settings,
  whatsappGeneral,
} from "../content/facts";
import { areaLine, meetupNote } from "../content/site";
import { draft } from "../render/drafts";
import type { SafeHtml } from "../render/html";
import { html } from "../render/html";
import type { Page } from "../render/layout";
import { faqList } from "./landing";

const LEGAL_DRAFT = "DRAF — BELUM DISEMAK PEGUAM";

function article(title: string, children: SafeHtml, options: { legal?: string } = {}): SafeHtml {
  return html`<article class="container narrow prose">
    <h1>${title}</h1>
    ${
      options.legal
        ? html`<p class="legal-draft" role="note">
            <strong>${LEGAL_DRAFT}</strong> · Versi ${options.legal}
          </p>`
        : null
    }
    ${children}
  </article>`;
}

const contact = html`WhatsApp <a href="${whatsappGeneral}">${phoneDisplay}</a>`;

export const termsPage: Page = {
  entry: "terma",
  path: "/terma",
  title: "Terma dan syarat",
  description: `Terma dan syarat sewaan kamera ${brand}.`,
  body: () =>
    draft(
      "Terma & syarat (perlu disemak peguam)",
      article(
        "Terma dan syarat sewaan",
        html`<h2>1. Tentang terma ini</h2>
          <p>
            Terma ini terpakai kepada setiap sewaan peralatan daripada ${brand}. Dengan membuat
            tempahan, anda bersetuju dengan terma ini serta <a href="/polisi">polisi sewaan</a> dan
            <a href="/privasi">notis privasi</a> kami.
          </p>
          <h2>2. Kelayakan penyewa</h2>
          <p>
            Penyewa mesti berumur 18 tahun ke atas dan menunjukkan MyKad yang sah semasa serahan.
            Kami berhak menolak sewaan tanpa memberi sebab.
          </p>
          <h2>3. Tempahan dan bayaran</h2>
          <p>
            Tempahan hanya sah selepas kami mengesahkannya dan bayaran penuh (sewa, aksesori dan
            deposit) diterima. Tempahan perlu dibuat sekurang-kurangnya ${minLeadHours.toString()}
            jam sebelum masa ambil, untuk tempoh paling lama ${maxDays.toString()} hari.
          </p>
          <h2>4. Deposit keselamatan</h2>
          <p>
            Deposit ${deposit} dipegang sepanjang tempoh sewaan dan dipulangkan selepas unit
            diperiksa. Caj lewat, kerosakan atau aksesori yang hilang boleh ditolak daripada
            deposit.
          </p>
          <h2>5. Penjagaan peralatan</h2>
          <p>
            Penyewa bertanggungjawab menjaga peralatan dari saat serahan hingga dipulangkan,
            mengikut <a href="/panduan">panduan sewaan</a>. Peralatan tidak boleh disewakan semula
            atau dipinjamkan kepada orang lain.
          </p>
          <h2>6. Kerosakan dan kehilangan</h2>
          <p>
            Kerosakan atau kehilangan semasa tempoh sewaan ditanggung oleh penyewa, mengikut kos
            pembaikan atau harga ganti semasa yang dimaklumkan kepada penyewa. Amaun yang melebihi
            deposit akan dituntut secara berasingan.
          </p>
          <h2>7. Lewat pulang dan pembatalan</h2>
          <p>Seperti dalam <a href="/polisi">polisi sewaan</a>.</p>
          <h2>8. Had tanggungan</h2>
          <p>
            ${brand} tidak bertanggungjawab atas kehilangan data, rakaman atau kerugian tidak
            langsung akibat penggunaan peralatan. Sila salin rakaman anda sebelum memulangkan unit.
          </p>
          <h2>9. Undang-undang</h2>
          <p>Terma ini tertakluk kepada undang-undang Malaysia.</p>
          <h2>10. Hubungi kami</h2>
          <p>Sebarang pertanyaan: ${contact}.</p>`,
        { legal: policyVersions.terms },
      ),
    ),
};

export const privacyPage: Page = {
  entry: "privasi",
  path: "/privasi",
  title: "Notis privasi",
  description: `Bagaimana ${brand} mengumpul dan menggunakan data peribadi anda.`,
  body: () =>
    draft(
      "Notis privasi (perlu disemak peguam; PDPA s.7(3) memerlukan versi BM dan Inggeris)",
      article(
        "Notis privasi",
        html`<p>
            Notis ini menerangkan bagaimana ${brand} memproses data peribadi anda menurut Akta
            Perlindungan Data Peribadi 2010.
          </p>
          <h2>Data yang kami kumpul</h2>
          <ul>
            <li>
              Borang minat: nama, nombor telefon bimbit, tarikh diingini, tujuan penggunaan dan dari
              mana anda mengetahui tentang kami.
            </li>
            <li>
              Semasa sewaan: empat digit terakhir nombor MyKad, siapa yang mengesahkannya dan bila.
              Kami <strong>tidak</strong> menyimpan salinan atau foto MyKad dalam sistem digital.
            </li>
            <li>
              Untuk keselamatan: alamat IP dan nombor telefon anda disimpan dalam bentuk hash (tidak
              boleh dibaca) untuk menghalang penyalahgunaan borang.
            </li>
          </ul>
          <h2>Tujuan</h2>
          <p>
            Untuk menjawab pertanyaan anda, mengurus tempahan dan sewaan, memulangkan deposit, dan
            melindungi sistem kami daripada penyalahgunaan. Kami tidak menjual data anda.
          </p>
          <h2>Pendedahan dan lokasi data</h2>
          <p>
            Data disimpan menggunakan Google Firebase (pusat data di Singapura) dan diproses melalui
            Cloudflare. Pengesahan keselamatan borang menggunakan Cloudflare Turnstile. Penyedia ini
            memproses data bagi pihak kami sahaja.
          </p>
          <h2>Tempoh simpanan</h2>
          <p>
            Kami menyimpan data hanya selama perlu untuk tujuan di atas dan untuk rekod perakaunan
            yang dikehendaki undang-undang.
          </p>
          <h2>Hak anda</h2>
          <p>
            Anda boleh meminta akses kepada, atau pembetulan, data peribadi anda, dan menarik balik
            persetujuan pada bila-bila masa, dengan menghubungi kami melalui ${contact}.
          </p>
          <h2>Persetujuan</h2>
          <p>
            Dengan menandakan kotak persetujuan pada borang, anda bersetuju data anda diproses
            seperti dalam notis ini. Versi notis yang anda setujui direkodkan bersama penyerahan
            anda.
          </p>`,
        { legal: policyVersions.privacy },
      ),
    ),
};

export const policyPage: Page = {
  entry: "polisi",
  path: "/polisi",
  title: "Polisi sewaan",
  description: `Deposit, pembatalan dan lewat pulang untuk sewaan ${brand}.`,
  body: () =>
    draft(
      "Polisi sewaan (perlu disemak peguam)",
      article(
        "Polisi sewaan",
        html`<h2>Deposit</h2>
          <p>
            Setiap sewaan memerlukan deposit keselamatan ${deposit}, dibayar bersama sewa. Deposit
            dipulangkan melalui DuitNow selepas unit dipulangkan dan diperiksa. Jika ada caj lewat,
            kerosakan atau aksesori hilang, amaun itu ditolak dan bakinya dipulangkan.
          </p>
          <h2>Pembatalan</h2>
          <table class="policy-table">
            <thead>
              <tr>
                <th scope="col">Bila dibatalkan</th>
                <th scope="col">Apa yang berlaku</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">Lebih ${cancellation.fullAbove.toString()} jam sebelum ambil</th>
                <td>Bayaran balik penuh, tolak caj sebenar gerbang pembayaran.</td>
              </tr>
              <tr>
                <th scope="row">
                  ${cancellation.feeFrom.toString()}–${cancellation.fullAbove.toString()} jam
                  sebelum ambil
                </th>
                <td>
                  Tukar tarikh sekali secara percuma, atau bayaran balik tolak ${cancellation.fee}.
                </td>
              </tr>
              <tr>
                <th scope="row">Kurang ${cancellation.feeFrom.toString()} jam, atau tidak hadir</th>
                <td>${cancellation.fee} dilucutkan; baki termasuk deposit dipulangkan.</td>
              </tr>
              <tr>
                <th scope="row">Dibatalkan oleh ${brand}</th>
                <td>Bayaran balik 100%.</td>
              </tr>
            </tbody>
          </table>
          <h2>Lewat pulang</h2>
          <p>
            Tempoh ihsan ${lateFee.grace.toString()} minit selepas slot pemulangan tamat. Selepas
            itu, ${lateFee.perBlock} bagi setiap ${lateFee.blockHours.toString()} jam yang
            dimulakan, maksimum ${lateFee.cap} bagi setiap 24 jam. Caj lewat disahkan oleh kami
            sebelum ditolak daripada deposit.
          </p>
          <h2>Serahan dan pemulangan</h2>
          <p>${meetupNote} Serahan dan pemulangan dibuat dalam slot masa yang dipersetujui.</p>
          <h2>Aksesori</h2>
          <p>
            ${filterBase} disertakan percuma apabila anda memilih mana-mana penapis lensa. Semua
            aksesori mesti dipulangkan bersama unit.
          </p>`,
        { legal: policyVersions.rentalPolicy },
      ),
    ),
};

export const guidePage: Page = {
  entry: "panduan",
  path: "/panduan",
  title: "Panduan sewaan",
  description: `Apa yang perlu dibuat sebelum, semasa dan selepas menyewa daripada ${brand}.`,
  body: () =>
    article(
      "Panduan sewaan",
      html`<h2>Sebelum hari ambil</h2>
        <ul>
          <li>Pastikan tempahan anda telah disahkan melalui WhatsApp.</li>
          <li>Sediakan MyKad yang sah untuk pengesahan identiti.</li>
          <li>Bawa kad memori atau telefon untuk menyimpan rakaman jika perlu.</li>
        </ul>
        <h2>Semasa serahan</h2>
        <ul>
          <li>Semak kit bersama kami dan pastikan semua item ada.</li>
          <li>Minta kami tunjukkan cara asas menggunakan kamera jika ini kali pertama anda.</li>
        </ul>
        <h2>Semasa menggunakan</h2>
        <ul>
          <li>Jauhkan kamera daripada air, pasir dan habuk. Kamera ini tidak kalis air.</li>
          <li>Jangan paksa gimbal bergerak dengan tangan; biarkan ia bergerak sendiri.</li>
          <li>Simpan dalam sarung apabila tidak digunakan.</li>
        </ul>
        <h2>Sebelum memulangkan</h2>
        <ul>
          <li>Salin semua rakaman anda. Kami akan memadam storan selepas pemulangan.</li>
          <li>Pulangkan semua item dalam kit, dalam slot yang dipersetujui di ${areaLine}.</li>
        </ul>
        <h2>Deposit</h2>
        <p>
          Deposit ${deposit} dipulangkan melalui DuitNow selepas unit diperiksa. Lihat
          <a href="/polisi">polisi sewaan</a> untuk butiran.
        </p>
        <p>Ada soalan? ${contact}.</p>`,
    ),
};

export const faqPage: Page = {
  entry: "soalan-lazim",
  path: "/soalan-lazim",
  title: "Soalan lazim",
  description: `Jawapan kepada soalan lazim tentang sewaan DJI Osmo Pocket 4P di ${brand}.`,
  body: () =>
    article(
      "Soalan lazim",
      html`${faqList()}
        <p>Soalan anda tiada di sini? ${contact}.</p>
        <p><a class="button" href="/#semak">Semak tarikh</a></p>`,
    ),
};

export const notFoundPage: Page = {
  entry: "404",
  path: "/404",
  title: "Halaman tidak dijumpai",
  description: "Halaman ini tidak wujud.",
  noindex: true,
  hidden: true,
  body: () =>
    article(
      "Halaman tidak dijumpai",
      html`<p>Pautan ini mungkin salah atau telah dialihkan.</p>
        <p><a class="button" href="/">Kembali ke laman utama</a></p>`,
    ),
};

export const adminPage: Page = {
  entry: "admin/index",
  path: "/admin/",
  title: "Admin",
  description: `Panel admin ${brand}.`,
  noindex: true,
  hidden: true,
  bare: true,
  script: "/src/admin.ts",
  body: () =>
    html`<div
      id="admin-app"
      class="admin"
      data-brand="${brand}"
      data-whatsapp="${settings.businessInfo.whatsappE164}"
    >
      <noscript>Panel admin memerlukan JavaScript.</noscript>
    </div>`,
};
