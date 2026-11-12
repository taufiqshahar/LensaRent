# Seni Bina

LensaRent ialah sistem tempahan sewaan kamera single-tenant: laman awam, wizard tempahan,
bayaran online dan panel admin. Dokumen ini menerangkan bentuk sistem; sebab di sebalik
setiap pilihan ada dalam [DECISIONS.md](DECISIONS.md).

**Status:** Fasa 0 (asas) siap. Bahagian bertanda _(Fasa 1/2)_ belum dibina.

## Gambaran

```
            Pelanggan / Admin (browser)
                       │  HTTPS, satu origin
                       ▼
        ┌──────────────────────────────────┐
        │        Cloudflare Worker         │
        │                                  │
        │  /api/*  ──► kod Worker          │──► CHIP (bayaran)        (Fasa 2)
        │  lain-lain ► aset statik         │──► Email API (outbox)    (Fasa 2)
        │  cron    ──► tugas berjadual     │──► Turnstile siteverify  (Fasa 1)
        └───────────────┬──────────────────┘
                        │  REST + token service account
                        ▼
        ┌──────────────────────────────────┐
        │  Firebase (asia-southeast1)      │
        │  Firestore · Auth · Storage      │
        │  Security Rules: deny-all        │
        └──────────────────────────────────┘
```

Tiada pelayan lain, tiada Cloud Functions. Satu Worker ialah satu-satunya compute.

## Prinsip teras: Worker ialah satu-satunya lapisan penguatkuasaan

Worker mengakses Firestore sebagai **service account**, dan akses service account
**memintas semua Security Rules**. Firestore pula tiada constraint, trigger atau foreign
key. Maka:

- Setiap peraturan integriti — tiada double-booking, peralihan status yang sah, ledger
  append-only, baki deposit sifar sebelum `completed` — disemak **dalam kod Worker**
  sebelum `commit`.
- Tiada client (termasuk panel admin) membaca atau menulis Firestore/Storage secara
  terus. Security Rules menolak semua orang; ia wujud hanya untuk menutup akses terus
  menggunakan konfigurasi web awam.
- Jika kod Worker salah, tiada apa-apa di belakangnya yang akan menangkap kesilapan itu.
  Sebab itu logik domain ditulis sebagai fungsi pure yang diuji habis-habisan, dan
  laluan kritikal diuji terhadap emulator.

## Komponen

### `packages/shared` — logik domain

Fungsi pure tanpa I/O, dikongsi oleh web dan Worker. Satu-satunya dependency ialah zod.

| Modul                | Tanggungjawab                                             |
| -------------------- | --------------------------------------------------------- |
| `money.ts`           | Wang sebagai integer sen; tolak float; `formatRM`         |
| `time.ts`            | Masa Malaysia (UTC+8 tetap); tarikh kalendar `yyyy-MM-dd` |
| `duration.ts`        | `rentalDays`, buffer, hari yang dikunci, validasi tempoh  |
| `pricing.ts`         | Harga sewa, add-on, meetup, diskaun, deposit → `quote()`  |
| `overlap.ts`         | Pertindihan julat tarikh dan selang masa                  |
| `stateMachine.ts`    | Jadual peralihan status tempahan; `canTransition`         |
| `ledger.ts`          | Jenis entri ledger; `depositBalanceSen`                   |
| `lateFee.ts`         | Cadangan caj lewat pulang                                 |
| `cancellation.ts`    | Hasil pembatalan mengikut polisi                          |
| `schemas.ts`         | Skema zod: primitif, enum, setiap dokumen `settings/*`    |
| `defaultSettings.ts` | Nilai awal `settings/*`                                   |

### `apps/worker` — Cloudflare Worker

| Fail                           | Tanggungjawab                                                    |
| ------------------------------ | ---------------------------------------------------------------- |
| `src/index.ts`                 | Titik masuk; sempadan ralat (respons generik, butiran ke log)    |
| `src/router.ts`                | Padanan laluan (`URLPattern`), 404/405                           |
| `src/lib/env.ts`               | Validasi binding; menolak hos emulator di staging/production     |
| `src/lib/googleAuth.ts`        | JWT service account (Web Crypto) → access token OAuth2           |
| `src/lib/firestoreValues.ts`   | Codec nilai JS ↔ JSON bertaip Firestore                          |
| `src/lib/firestore.ts`         | Klien REST: `get`, `getAll`, `query`, `commit`, `runTransaction` |
| `src/lib/availabilityLocks.ts` | `acquireDayLocks`, `releaseDayLocks`                             |
| `src/lib/logger.ts`            | Log JSON berstruktur dengan redaksi PII                          |
| `src/lib/http.ts`              | Respons JSON, header keselamatan, katalog ralat                  |

Endpoint semasa: `GET /api/health`. Endpoint lain tiba mengikut fasa (master prompt §10).

### `apps/web` — laman statik

Vite multi-halaman, TypeScript strict, tanpa framework UI, CSS biasa. HTML merujuk teks
sebagai `{{t:key}}` yang digantikan daripada `strings.bm.ts` semasa build. Fasa 0 hanya
mengandungi halaman placeholder dan 404.

### `firebase` — rules dan emulator

`firestore.rules` dan `storage.rules` (deny-all), `firestore.indexes.json`, konfigurasi
emulator, dan ujian rules.

## Aliran permintaan

1. Cloudflare menerima permintaan. Laluan selain `/api/*` dihidang terus daripada aset
   statik (`run_worker_first = ["/api/*"]`), dengan header daripada fail `_headers`.
2. `/api/*` sampai ke Worker. `loadConfig` mengesahkan binding; router memilih handler.
3. Handler mengesahkan input (zod), menjalankan logik domain (`packages/shared`), dan
   membina senarai write.
4. `Firestore.commit` menghantar semua write dalam satu panggilan atomik. Precondition
   yang gagal membatalkan keseluruhan commit.
5. Sebarang ralat tidak dijangka → respons `500` generik dalam BM; butiran (diredaksi)
   ke log.

## Persekitaran

|               | Lokal                       | Staging                           | Production                         |
| ------------- | --------------------------- | --------------------------------- | ---------------------------------- |
| `ENVIRONMENT` | `development` / `test`      | `staging`                         | `production`                       |
| Firestore     | Emulator (`demo-lensarent`) | Projek Firebase staging           | Projek Firebase production         |
| Kelayakan     | Tiada (emulator)            | Secret `FIREBASE_SERVICE_ACCOUNT` | Secret berasingan                  |
| Deploy        | `wrangler dev`              | `wrangler deploy --env staging`   | `wrangler deploy --env production` |

Staging tidak pernah mengandungi data sebenar. Rahsia hanya dalam Worker secrets dan
GitHub Secrets.

## Apa yang belum ada

| Fasa | Kandungan                                                                                             |
| ---- | ----------------------------------------------------------------------------------------------------- |
| 1    | Landing page, borang minat (`leads`), Turnstile, rate limit, log masuk admin, senarai leads           |
| 2    | Ketersediaan, hold, checkout CHIP, webhook, halaman status, operasi admin, outbox email, cron, backup |
| 3    | Laporan, kod referral, automasi retention                                                             |
