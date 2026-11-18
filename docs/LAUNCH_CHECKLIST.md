# Senarai semak pelancaran

Semua kod Fasa 0–2 siap dan diuji. Perkara di bawah memerlukan **pemilik** (akaun,
keputusan, semakan undang-undang). Tanda ✅ apabila selesai. Langkah teknikal terperinci:
`DEPLOYMENT_AND_BACKUP.md`.

## A. Keputusan perniagaan (tanpa ini, sistem tidak boleh dibuka)

- [ ] **Jadual slot serahan** — hari, masa mula/tamat, ambil/pulang, lokasi setiap slot.
      (Dimasukkan sendiri dalam Admin → Tetapan selepas deploy, atau beri kepada pembangun.)
- [ ] Sahkan tafsiran dalam `DECISIONS.md` → "Tafsiran domain yang menunggu pengesahan"
      (13 perkara: tambahan RM5 sekali, tahanan 15 minit, had caj lewat, dll.).
- [ ] Maklumat perniagaan untuk footer & resit: nama berdaftar, no. SSM, alamat, emel.
- [ ] Bilangan unit kamera dan no. siri setiap satu.

## B. Undang-undang

- [ ] Peguam menyemak **Terma**, **Polisi sewaan** dan **Notis privasi** (bertanda
      "DRAF — BELUM DISEMAK PEGUAM"). Notis privasi perlu versi BM **dan Inggeris** (PDPA s.7(3)).
- [ ] Akauntan: tempoh simpanan rekod kewangan; layanan deposit sebagai liabiliti.
- [ ] Selepas semakan: kemas kini `policyVersions` dan buang `draft()` yang berkaitan.

## C. Akaun & kunci (semua atas nama perniagaan)

- [ ] Cloudflare: akaun, **Workers Paid** (USD5/bulan, ADR-005), domain.
- [ ] D1: `lensarent-staging`, `lensarent-production` (`--location apac`) → id ke `wrangler.toml`.
- [ ] R2: `lensarent-photos-staging`, `lensarent-photos-production`, `lensarent-backups`
      (semua **tanpa akses awam**; lifecycle 90 hari pada `lensarent-backups`).
- [ ] Cloudflare Access: aplikasi untuk `/admin` dan `/api/admin`, emel admin → `ADMIN_EMAILS`, AUD → `ACCESS_AUD`.
- [ ] Turnstile: site key (web `.env.production`) + secret (Worker).
- [ ] **CHIP**: akaun peniaga diluluskan, kunci UJIAN untuk staging, kunci LIVE untuk
      production, brand id → `CHIP_SECRET_KEY`, `CHIP_BRAND_ID`.
- [ ] **Resend**: domain pengirim disahkan (SPF/DKIM), kunci API → `RESEND_API_KEY`, `EMAIL_FROM`.
- [ ] `SITE_ORIGIN` (Worker) dan `VITE_SITE_ORIGIN` (web).
- [ ] GitHub secrets `CLOUDFLARE_API_TOKEN` (D1 + R2 sahaja) dan `CLOUDFLARE_ACCOUNT_ID` untuk sandaran.

## D. Staging (wajib lulus sebelum production)

Ikut `DEPLOYMENT_AND_BACKUP.md` §3, termasuk "Fasa 2": tempahan penuh dengan kunci ujian
CHIP, tahanan tamat, kitaran serahan → pulang → deposit, pembatalan + bayaran balik, emel
diterima, sandaran manual berjaya.

## E. Hari pelancaran

- [ ] `pnpm --filter @lensarent/web build:production` lulus (tiada draf, kunci sebenar).
- [ ] `wrangler d1 migrations apply DB --env production --remote`, kemudian `wrangler deploy --env production`.
- [ ] Unit dan slot dimasukkan; `GET /api/config` → `bookingOpen: true`.
- [ ] Satu tempahan sebenar bernilai kecil oleh pemilik, kemudian batal + bayar balik.
- [ ] Baca `RUNBOOK_MANUAL_FALLBACK.md`; simpan nombor sokongan CHIP dan Cloudflare.
- [ ] Pin tindakan GitHub kepada SHA (risiko terbuka dalam `SECURITY_AND_PRIVACY.md`).
