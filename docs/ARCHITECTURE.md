# Seni Bina

LensaRent ialah sistem tempahan sewaan kamera single-tenant: laman awam, borang minat,
panel admin, dan kemudian tempahan dengan bayaran online. Sebab di sebalik setiap pilihan
ada dalam [DECISIONS.md](DECISIONS.md).

**Status:** Fasa 0 dan Fasa 1 siap, belum dideploy. Stack bertukar ke Cloudflare D1 +
Access pada 18 Nov 2026 (ADR-017/018). Bahagian bertanda _(Fasa 2)_ belum dibina.

## Gambaran

```
            Pelanggan / Admin (browser)
                       │  HTTPS, satu origin
                       ▼
        ┌──────────────────────────────────────┐
        │ Cloudflare                           │
        │  Access ── melindungi /admin, /api/admin (OTP emel / Google)
        │  Turnstile ── borang awam             │
        │                                       │
        │  Worker                               │──► CHIP (bayaran)      (Fasa 2)
        │   /api/*  ──► kod Worker ──► D1 (SQL) │──► Email API (outbox)  (Fasa 2)
        │   lain-lain ► aset statik             │
        │   cron    ──► tugas berjadual (Fasa 2)│
        └──────────────────────────────────────┘
```

Satu akaun, satu platform: tiada pelayan lain, tiada Google Cloud.

## Prinsip teras

- **Worker ialah lapisan penguatkuasaan utama.** Setiap peraturan integriti disemak dalam
  kod sebelum menulis: tiada double-booking, peralihan status yang sah, ledger
  append-only, baki deposit sifar sebelum `completed`.
- **D1 menyokong dari belakang.** Kunci primer, `CHECK` dan trigger menolak data yang tidak
  sah walaupun kod tersilap. Contohnya, double-booking dihalang oleh PRIMARY KEY.
- **Tiada client menyentuh pangkalan data.** Semua melalui `/api/*`.
- **Logik domain ialah fungsi pure** dalam `packages/shared`, diuji habis-habisan dan
  dikongsi oleh pelayan dan browser.

## Komponen

### `packages/shared` — logik domain

Fungsi pure tanpa I/O. Satu-satunya dependency ialah zod.

| Modul                              | Tanggungjawab                                           |
| ---------------------------------- | ------------------------------------------------------- |
| `money.ts`                         | Wang sebagai integer sen; `formatRM`                    |
| `time.ts`                          | Masa Malaysia (UTC+8); tarikh kalendar                  |
| `duration.ts`                      | `rentalDays`, buffer, hari dikunci, validasi tempoh     |
| `pricing.ts`                       | `quote()`: sewa, add-on, meetup, diskaun, deposit       |
| `overlap.ts`                       | Pertindihan julat                                       |
| `stateMachine.ts`                  | Peralihan status tempahan; `canTransition`              |
| `ledger.ts`                        | Jenis entri; `depositBalanceSen`                        |
| `lateFee.ts`, `cancellation.ts`    | Caj lewat; hasil pembatalan                             |
| `phone.ts`                         | Nombor bimbit Malaysia → E.164; pautan WhatsApp         |
| `leads.ts`, `leadOptions.ts`       | Skema borang minat; label BM (tanpa zod, untuk browser) |
| `schemas.ts`, `defaultSettings.ts` | Skema dan nilai awal `settings`                         |

### `apps/worker` — Cloudflare Worker

| Fail                                                                  | Tanggungjawab                                                                               |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `migrations/*.sql`                                                    | Skema D1 (lihat [DATABASE_SCHEMA.md](DATABASE_SCHEMA.md))                                   |
| `src/index.ts`, `src/app.ts`                                          | Titik masuk, senarai laluan, sempadan ralat                                                 |
| `src/services.ts`                                                     | Perkhidmatan setiap permintaan (D1, Turnstile, hasher, pengesah admin); diganti dalam ujian |
| `src/routes/*.ts`                                                     | `leads`, `adminLeads`, pengawal `adminAuth`, `validation`                                   |
| `src/lib/env.ts`                                                      | Validasi binding; menolak log masuk dev di staging/production                               |
| `src/lib/access.ts`                                                   | Pengesahan JWT Cloudflare Access (`jose`) + senarai emel admin                              |
| `src/lib/availabilityLocks.ts`                                        | `acquireDayLocks` / `releaseDayLocks` (satu batch atomik)                                   |
| `src/lib/rateLimit.ts`                                                | Kaunter had kadar dalam D1                                                                  |
| `src/lib/db.ts`, `audit.ts`                                           | Helper D1 (konflik unik, ID); entri audit                                                   |
| `src/lib/turnstile.ts`, `crypto.ts`, `csv.ts`, `http.ts`, `logger.ts` | Turnstile, HMAC, CSV selamat, respons/ralat, log diredaksi                                  |

Endpoint: lihat [API_SPECIFICATION.md](API_SPECIFICATION.md).

### `apps/web` — laman statik

Vite multi-halaman, TypeScript, tanpa framework UI (ADR-015).

| Bahagian         | Kandungan                                                                            |
| ---------------- | ------------------------------------------------------------------------------------ |
| `src/pages/*.ts` | Setiap halaman sebagai fungsi yang memulangkan HTML                                  |
| `src/content/`   | `facts.ts` (angka daripada settings), `site.ts` (teks BM; `draft()`)                 |
| `src/render/`    | Templat `html` yang meng-escape, susun atur, pengawal draf                           |
| `src/main.ts`    | Kalkulator harga + borang minat (Turnstile dimuat malas)                             |
| `src/admin.ts`   | Panel admin: leads, status, nota, WhatsApp, CSV                                      |
| `vite.config.ts` | Menjana HTML, `robots.txt`, `sitemap.xml`; menolak build production yang belum sedia |

## Aliran permintaan

1. Cloudflare menerima permintaan. Untuk `/admin*` dan `/api/admin*`, **Access** meminta
   log masuk dahulu, kemudian menambah JWT bertandatangan pada permintaan.
2. Laluan selain `/api/*` dihidang terus daripada aset statik, dengan header daripada
   `_headers`.
3. `/api/*` sampai ke Worker. `loadConfig` mengesahkan binding, dan router memilih handler.
4. Handler mengesahkan input (zod), mengesahkan admin jika perlu (`requireAdmin`:
   JWT + emel + Origin), menjalankan logik domain, dan menulis ke D1. Tulisan yang
   berkaitan dihantar dalam satu `batch` (satu transaksi).
5. Ralat tidak dijangka menghasilkan `500` generik dalam BM; butiran diredaksi dan dihantar
   ke log.

## Persekitaran

|               | Lokal                   | Staging                         | Production                         |
| ------------- | ----------------------- | ------------------------------- | ---------------------------------- |
| `ENVIRONMENT` | `development` / `test`  | `staging`                       | `production`                       |
| D1            | Tempatan (`.wrangler/`) | `lensarent-staging`             | `lensarent-production`             |
| Admin         | `ACCESS_DEV_EMAIL`      | Cloudflare Access               | Cloudflare Access                  |
| Deploy        | `pnpm dev`              | `wrangler deploy --env staging` | `wrangler deploy --env production` |

## Apa yang belum ada

| Fasa | Kandungan                                                                                                         |
| ---- | ----------------------------------------------------------------------------------------------------------------- |
| 2    | Ketersediaan, hold, checkout CHIP, webhook, halaman status, operasi admin, outbox email, cron, backup luar talian |
| 3    | Laporan, kod referral, automasi retention                                                                         |
