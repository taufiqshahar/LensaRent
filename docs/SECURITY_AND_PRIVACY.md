# Keselamatan & Privasi

**Status:** kawalan bertanda ✅ sudah dilaksana dan diuji (Fasa 0). Yang bertanda 📌
dirancang untuk fasa yang dinyatakan.

## Model: Worker ialah satu-satunya lapisan penguatkuasaan

```
Browser ──► Worker ──(service account)──► Firestore / Storage
   │                                            ▲
   └────────────── DITOLAK oleh rules ──────────┘
```

1. **Worker menulis sebagai service account, yang memintas Security Rules.** Rules tidak
   melindungi data daripada kesilapan dalam kod Worker. Firestore pula tiada constraint.
   Setiap invarian mesti disemak dalam kod Worker sebelum `commit`.
2. **Tiada client menyentuh Firestore atau Storage secara terus** — pelanggan mahupun
   admin. Rules ialah `allow read, write: if false` untuk semua. Peranan rules hanyalah
   menutup akses terus menggunakan konfigurasi web awam Firebase.
3. **Akibatnya:** semakan kod Worker dan ujiannya ialah kawalan keselamatan utama, bukan
   pelengkap.

| Invarian                               | Dikuatkuasakan oleh                                               | Status                        |
| -------------------------------------- | ----------------------------------------------------------------- | ----------------------------- |
| Tiada double-booking                   | `acquireDayLocks`: satu commit atomik, `exists=false` setiap hari | ✅                            |
| Kunci hanya dilepaskan oleh pemiliknya | `releaseDayLocks` dalam transaction                               | ✅                            |
| Peralihan status sah sahaja            | `canTransition` dalam transaction endpoint                        | ✅ logik · 📌 endpoint Fasa 2 |
| Ledger append-only                     | Worker hanya memanggil `createDoc` pada `ledgerEntries`           | 📌 Fasa 2                     |
| Baki deposit 0 sebelum `completed`     | `depositBalanceSen` dalam transaction                             | ✅ logik · 📌 endpoint Fasa 2 |
| Webhook diproses sekali                | `createDoc` pada ID deterministik                                 | ✅ primitif · 📌 Fasa 2       |
| Wang tanpa float                       | zod + codec Firestore menolak bukan integer                       | ✅                            |

## Akses dan identiti

- ✅ Security Rules deny-all untuk Firestore dan Storage; diuji untuk pelawat, pengguna
  log masuk dan **admin log masuk** pada setiap koleksi.
- 📌 Fasa 1: endpoint `/api/admin/*` mengesahkan ID token Firebase (RS256, JWKS Google,
  pustaka `jose`) dan `claims.admin === true`.
- 📌 Fasa 1: tiada signup awam. Admin dicipta melalui `scripts/grant-admin.ts` sahaja.
- ⏳ MFA admin: menunggu keputusan pemilik (ADR-004).

## Rahsia

- ✅ Service account, kunci CHIP, kunci email, secret Turnstile, `PHONE_HASH_PEPPER`
  hanya dalam Worker secrets / GitHub Secrets. `.dev.vars` di-gitignore; hanya
  `.dev.vars.example` (tanpa nilai) dalam repo.
- 📌 Fasa 1: service account production dan staging berasingan.
- ✅ Worker enggan berjalan jika `FIRESTORE_EMULATOR_HOST` diset di staging/production,
  dan hos emulator mesti loopback (emulator menerima sesiapa sahaja sebagai pemilik).
- ✅ Ralat konfigurasi dan ralat auth menamakan binding sahaja, tidak pernah nilainya.
  Respons ralat Google tidak diulang ke dalam log.
- ✅ Imbasan rahsia (gitleaks) pada setiap push.
- ✅ Tiada nilai sensitif disimpan di Firestore.

## Endpoint

- ✅ Respons ralat generik dalam BM: `{ error: { code, message } }`. Tiada stack trace,
  tiada butiran dalaman. Butiran pergi ke log yang diredaksi.
- ✅ `GET /api/health` tidak menyentuh backend, jadi tidak boleh digunakan untuk
  menaikkan kos.
- ✅ Setiap query Firestore mesti mempunyai `limit` (maks 1000); tiada bacaan tanpa had.
- ✅ Laluan dokumen disahkan (tiada segmen kosong, `.` atau `..`).
- 📌 Fasa 1: Turnstile + rate limit dua lapis (ADR-007), zod pada semua input.
- 📌 Fasa 2: perbandingan token masa-malar; `lookupToken` 32 byte, hanya hash disimpan;
  lookup dengan token salah → 404 generik.

## Header keselamatan

| Header                      | Aset statik (`_headers`)                        | API (`lib/http.ts`)                          |
| --------------------------- | ----------------------------------------------- | -------------------------------------------- |
| `Content-Security-Policy`   | `default-src 'self'` … `frame-ancestors 'none'` | `default-src 'none'; frame-ancestors 'none'` |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains`           | sama                                         |
| `X-Content-Type-Options`    | `nosniff`                                       | `nosniff`                                    |
| `X-Frame-Options`           | `DENY`                                          | `DENY`                                       |
| `Referrer-Policy`           | `strict-origin-when-cross-origin`               | `no-referrer`                                |
| `Permissions-Policy`        | kamera, mikrofon, lokasi, bayaran dimatikan     | sama                                         |
| `Cache-Control`             | —                                               | `no-store`                                   |

✅ Disahkan di `wrangler dev`. 📌 CSP diperluas untuk Turnstile dan Firebase Auth
(Fasa 1) dan CHIP (Fasa 2) — hanya domain yang benar-benar diperlukan.

✅ **Tiada `innerHTML`** dalam `apps/web`: dikuatkuasakan oleh ESLint
(`innerHTML`, `outerHTML`, `insertAdjacentHTML` dilarang). Rentetan dalam HTML di-escape
semasa build.

## Log

✅ Logger berstruktur (`lib/logger.ts`) meredaksi dalam dua lapis:

1. **Mengikut kunci** — medan seperti `name`, `phone*`, `email`, `idLast4`, `*token*`,
   `address`, `notes`, `customerSnapshot`, `authorization`, `*secret*` digantikan
   sepenuhnya.
2. **Mengikut nilai** — setiap rentetan lain dibersihkan daripada email, nombor telefon
   (antarabangsa, gaya wa.me, tempatan), JWT, token Bearer, blok private key dan rentetan
   legap panjang.

Kenal pasti rekod dengan `bookingId` / `refCode` sahaja. Stack trace hanya dalam
development/test. Ujian snapshot membuktikan tiada PII yang ditanam sampai ke output.

## Privasi (PDPA)

- **Tiada salinan atau foto MyKad, dan tiada nombor IC penuh** dalam sistem ini. Hanya 4
  digit akhir, siapa mengesahkan, dan bila. Salinan fizikal untuk borang kertas diurus di
  luar sistem.
- Telefon disimpan sebagai E.164 dan sebagai `phoneHash` (HMAC-SHA256 dengan pepper)
  untuk carian dan rate limit.
- 📌 Fasa 2: persetujuan direkod dengan versi T&C/privasi, masa dan hash IP.
- 📌 Fasa 2/3: foto serahan dipadam 30 hari selepas baki deposit = 0 tanpa pertikaian.
- ⚠️ Tempoh simpanan rekod kewangan: **perlu disahkan dengan akauntan** sebelum
  automasi retention dibina.
- Audit log merekod nama medan yang berubah, bukan nilainya.

## Risiko terbuka

| Risiko                                              | Mitigasi / status                                    |
| --------------------------------------------------- | ---------------------------------------------------- |
| Kesilapan kod Worker tidak ditangkap oleh Firestore | Logik pure + ujian emulator; semakan kod setiap fasa |
| Emulator tidak menguatkuasakan composite index      | Semak dan tambah index bersama setiap query baharu   |
| Akaun admin tanpa MFA                               | ⏳ ADR-004 sebelum Fasa 1 dilancarkan                |
| Pertukaran token OAuth sebenar belum diuji          | Disahkan pada deploy staging pertama                 |
| Tindakan GitHub dirujuk dengan tag major, bukan SHA | Pin ke SHA sebelum production                        |
