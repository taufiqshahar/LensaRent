# Ujian & Kriteria Penerimaan

**Status:** 760 ujian automatik lulus, ditambah satu semakan E2E Playwright manual.

| Suite                                            | Di mana ia berjalan   | Ujian |
| ------------------------------------------------ | --------------------- | ----- |
| Logik domain (`packages/shared`)                 | Node                  | 621   |
| Laman web: render build-time (`apps/web`)        | Node                  | 10    |
| Worker: unit (`test/unit`)                       | workerd               | 75    |
| Worker: integrasi dengan D1 (`test/integration`) | workerd + D1 tempatan | 54    |

Ujian Worker berjalan dalam **workerd**, runtime yang sama dengan production, melalui
`@cloudflare/vitest-plugin`, dengan pangkalan data **D1 tempatan** yang menggunakan semua
migrasi sebelum ujian. Tiada emulator, Java atau akaun diperlukan.

## Cara menjalankan

```sh
pnpm typecheck   # TS strict, semua pakej
pnpm lint        # ESLint + semakan format Prettier
pnpm test        # semua suite di atas
pnpm build       # build Vite (staging) + wrangler deploy --dry-run
```

CI menjalankan kesemuanya pada setiap push, serta imbasan rahsia gitleaks ke atas seluruh
sejarah.

## Liputan

`packages/shared` mempunyai gate **90%** (baris, cabang, fungsi, pernyataan); ujian gagal
di bawahnya. Semasa: **100%** pada keempat-empatnya.

## Apa yang dibuktikan

### Logik domain

| Bidang                        | Liputan                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------- |
| Wang                          | Integer sahaja; float, `NaN`, integer tidak selamat ditolak; format RM                |
| Masa                          | Hari MYT lwn UTC, disemak silang dengan `Intl` untuk 2,600 instant; tahun lompat      |
| Tempoh                        | `rentalDays` pada setiap sempadan; buffer biasa/peak; buffer tamat tepat tengah malam |
| Harga                         | Setiap tempoh 1–7 hari; had add-on; meetup; diskaun; deposit                          |
| State machine                 | **Semua 363 gabungan** status × status × actor lwn jadual bebas                       |
| Ledger, caj lewat, pembatalan | Setiap sempadan; refund tidak pernah negatif                                          |
| Telefon & lead                | Normalisasi bimbit Malaysia; skema borang dan kemas kini                              |
| Skema settings                | Setiap nilai lalai sah; 29 kes tidak sah ditolak                                      |

### Worker — unit

- **Cloudflare Access:** token sah diterima. Ditolak: audience lain, issuer lain, tamat
  tempoh, emel bukan admin, tiada emel/subject, kunci lain, tanpa tandatangan, sampah,
  tiada token. Kunci awam diambil sekali dan dicache; diambil semula apabila kunci diputar;
  **fail closed** jika kunci tidak dapat diambil.
- **Konfigurasi:** log masuk dev ditolak di production; Access wajib di staging/production;
  `ADMIN_EMAILS`, AUD dan domain pasukan disahkan; ralat tidak pernah mengandungi rahsia.
- **Lain-lain:** HMAC, bacaan badan JSON (jenis, saiz), Origin, CSV, Turnstile
  (strict/tidak strict/gagal), router 404/405/500, header keselamatan.
- **Logger:** snapshot bebas PII.

### Worker — integrasi dengan D1

- **Semantik D1 yang diharapkan:** `batch()` di-rollback sepenuhnya apabila satu statement
  gagal; konflik kunci dikenal pasti dengan betul.
- **Skema:** setiap nilai enum dalam kod diterima oleh `CHECK`, dan nilai lain ditolak.
  Kunci slot mesti mempunyai tepat satu pemilik. **Audit log tidak boleh diubah atau
  dipadam** (trigger).
- **Had kadar:** 10 serentak untuk had 3 → tepat 3 lulus; tetingkap baharu bermula semula;
  baris tamat dibersihkan.
- **Kunci slot:** satu baris setiap hari; statement pemanggil dalam transaksi yang sama;
  pertindihan → tiada apa-apa ditulis; boleh diulang; maintenance lwn tempahan; pelepasan
  hanya oleh pemilik.
- **`POST /api/leads`:** disimpan dinormalkan tanpa IP mentah; ralat per medan dalam BM;
  tarikh lalu atau melebihi setahun ditolak; Turnstile gagal → tiada tulisan; had per
  telefon dan per IP; 6 serentak untuk had 3 → tepat 3; burst limiter.
- **Admin:** semua endpoint → 401 tanpa token Access yang sah; Origin lain → 403; tapis
  hari/status; halaman stabil termasuk **lead dengan cap masa yang sama**; kemas kini +
  audit (nama medan sahaja); kemas kini tidak sah atau lead tiada → **tiada audit
  direkod**; eksport CSV menapis dan meneutralkan formula.

## Ujian paling kritikal: perlumbaan kunci slot

`apps/worker/test/integration/availabilityLocks.test.ts`, terhadap D1.

Setiap pusingan melancarkan **20 permintaan serentak** ke atas satu unit. Julat tarikh
mereka berbeza tetapi semuanya berkongsi sekurang-kurangnya satu hari, dan setiap
permintaan turut menulis rekod "tempahan" dalam transaksi yang sama. Selepas setiap
pusingan:

1. tepat **satu** permintaan berjaya;
2. hanya hari milik pemenang yang dikunci (tiada kunci yatim);
3. hanya rekod pemenang yang wujud;
4. setiap yang kalah diberitahu hari mana yang bertembung, dan hari itu memang milik pemenang.

**50 pusingan** (1,000 permintaan) setiap kali `pnpm test` dijalankan, termasuk dalam CI.

## Kriteria penerimaan master prompt §12

| Kriteria                                              | Status                                                            |
| ----------------------------------------------------- | ----------------------------------------------------------------- |
| Client tidak boleh menulis terus ke pangkalan data    | ✅ Mengikut reka bentuk: D1 tiada akses client                    |
| Bacaan admin sahaja                                   | ✅ Access + pengesahan JWT di Worker (ADR-018)                    |
| Dua create serentak untuk hari/unit sama → tepat satu | ✅ 20 serentak × 50 pusingan                                      |
| `webhookEvents` idempotent                            | 📌 Fasa 2 (PK `(provider, event_key)`)                            |
| Ledger: update/delete ditolak                         | ✅ Corak trigger dibuktikan pada `audit_logs` · 📌 jadual Fasa 2  |
| `receiptCounters`: 10 serentak → unik berjujukan      | 📌 Fasa 2 (`UPDATE … RETURNING`)                                  |
| Log bebas PII                                         | ✅                                                                |
| Rate limit & Turnstile                                | ✅ (Turnstile disimulasi; siteverify sebenar disahkan di staging) |
| Aliran tempahan penuh, webhook, overdue, lookup       | 📌 Fasa 2                                                         |

## E2E (Playwright, manual — tidak dalam CI)

`wrangler dev` + D1 tempatan, pada saiz iPhone 13 dan Pixel 7. **23/23 semakan lulus:**

- **Laman awam:** tiada skrol mendatar; kalkulator (3 hari + CPL = RM275); ralat medan dan
  mesej berjaya pada borang (API dan Turnstile disimulasi); semua halaman polisi; 404;
  tiada ralat konsol.
- **Admin:** tiada borang log masuk (Access); emel admin dipaparkan; log keluar melalui
  `/cdn-cgi/access/logout`; senarai terbaharu dahulu; pautan WhatsApp pra-isi; tukar
  status; nota; tapis; eksport CSV.

**Lighthouse mobile (build tempatan, sebelum penukaran stack; laman awam tidak berubah):**
Performance 100, Accessibility 100, Best Practices 100. SEO 63 kerana staging sengaja
`noindex`.

## Had yang diketahui

- Cloudflare Access sebenar dan Turnstile sebenar tidak dapat diuji tanpa akaun; kedua-duanya
  disenaraikan dalam semakan selepas deploy (`DEPLOYMENT_AND_BACKUP.md`).
- D1 tempatan berjalan dalam satu proses; kekangan PRIMARY KEY yang menjamin ketepatan
  adalah sama di production.
