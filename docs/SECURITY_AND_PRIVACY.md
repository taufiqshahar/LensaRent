# Keselamatan & Privasi

**Status:** kawalan bertanda ✅ sudah dilaksana dan diuji. Yang bertanda 📌 dirancang untuk
fasa yang dinyatakan. Stack: Cloudflare Workers + D1 + Access + Turnstile (ADR-017/018).

## Model: Worker menguatkuasakan, pangkalan data menyokong

```
Browser ──► Cloudflare (Access untuk /admin, Turnstile untuk borang) ──► Worker ──► D1
```

1. **Tiada client menyentuh pangkalan data.** D1 hanya boleh dicapai melalui binding Worker;
   tiada URL awam dan tiada "rules" untuk tersalah konfigurasi.
2. **Worker ialah lapisan penguatkuasaan utama**: validasi zod, logik domain dan semakan
   sebelum setiap tulisan.
3. **D1 ialah lapisan kedua**: PRIMARY KEY, `CHECK` dan trigger menolak apa yang tidak
   sepatutnya wujud, walaupun ada pepijat dalam kod.

| Invarian                                               | Dikuatkuasakan oleh                                          | Status                        |
| ------------------------------------------------------ | ------------------------------------------------------------ | ----------------------------- |
| Tiada double-booking                                   | PK `(unit_id, date)` + satu batch atomik (`acquireDayLocks`) | ✅                            |
| Kunci hanya dilepaskan oleh pemiliknya                 | `DELETE … WHERE booking_id/block_id = ?`                     | ✅                            |
| Satu pemilik setiap kunci; hanya hold tamat            | `CHECK` dalam skema                                          | ✅                            |
| Enum dan format sah                                    | zod + `CHECK`                                                | ✅                            |
| Audit log append-only                                  | Trigger `BEFORE UPDATE/DELETE`                               | ✅                            |
| Audit tidak direkod untuk perubahan yang tidak berlaku | `INSERT … WHERE EXISTS` dalam batch yang sama                | ✅                            |
| Peralihan status sah sahaja                            | `canTransition` dalam endpoint                               | ✅ logik · 📌 endpoint Fasa 2 |
| Ledger append-only                                     | Trigger (seperti `audit_logs`)                               | 📌 Fasa 2                     |
| Baki deposit 0 sebelum `completed`                     | `depositBalanceSen`                                          | ✅ logik · 📌 endpoint Fasa 2 |
| Webhook diproses sekali                                | PK `(provider, event_key)`                                   | 📌 Fasa 2                     |
| Wang tanpa float                                       | zod + `CHECK (typeof(x) = 'integer')`                        | ✅ logik · 📌 jadual Fasa 2   |

## Akses admin (Cloudflare Access)

- ✅ `/admin/*` dan `/api/admin/*` di belakang Cloudflare Access: OTP ke emel yang
  dibenarkan, atau Google. Access tidak menghantar kod kepada emel yang tidak dibenarkan.
- ✅ **Worker tidak mempercayai konfigurasi Access secara buta**. Setiap permintaan admin
  memerlukan header `Cf-Access-Jwt-Assertion` yang sah: tandatangan RS256 terhadap kunci
  pasukan, issuer, AUD aplikasi dan tamat tempoh (`jose`). Emel juga mesti ada dalam
  `ADMIN_EMAILS`. Laluan tersalah konfigurasi atau `workers.dev` → 401.
- ✅ Kunci awam Access dicache sebagai nilai dan diambil semula apabila Cloudflare
  memutarnya. Jika kunci tidak dapat diambil, permintaan ditolak (fail closed).
- ✅ CSRF: setiap permintaan admin yang mengubah data mesti membawa `Origin` sama, dan
  badannya mesti JSON.
- ✅ MFA: OTP emel / Google melalui Access (ADR-018). Boleh diperketat dalam polisi tanpa
  menukar kod.
- ✅ Tiada kata laluan admin disimpan atau diproses oleh sistem ini.
- ✅ `ACCESS_DEV_EMAIL` (log masuk tempatan) ditolak oleh Worker di staging/production.

## Rahsia

- ✅ Hanya dua rahsia: `TURNSTILE_SECRET_KEY` dan `PHONE_HASH_PEPPER`, dalam Worker
  secrets. Tiada service account dan tiada kunci API pihak ketiga.
- ✅ `.dev.vars` di-gitignore; hanya `.dev.vars.example` (tanpa nilai sebenar) dalam repo.
- ✅ Nilai Access (`ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `ADMIN_EMAILS`) bukan rahsia; ia
  disimpan dalam `wrangler.toml`.
- ✅ Ralat konfigurasi menamakan binding sahaja, tidak pernah nilainya.
- ✅ Imbasan rahsia (gitleaks) pada setiap push, ke atas seluruh sejarah.

## Endpoint awam

- ✅ Turnstile (hostname + action disemak di staging/production).
- ✅ Had kadar dua lapis (ADR-007): 10 lead/jam per IP, 3/hari per telefon.
- ✅ zod `strictObject` pada semua input; badan ≤ 16 KiB, JSON sahaja.
- ✅ Respons ralat generik dalam BM; tiada stack trace dan tiada input dipantulkan.
- ✅ Semua SQL menggunakan parameter terikat; syarat dinamik dibina daripada nilai yang
  telah disahkan sahaja (`routes/adminLeads.ts`).
- ✅ Eksport CSV meneutralkan formula (CSV injection).
- 📌 Fasa 2: `lookupToken` 32 bait, hanya hash disimpan; token salah → 404 generik.

## Header keselamatan

| Header                      | Aset statik (`_headers`)                           | `/admin/*`          | API (`lib/http.ts`)  |
| --------------------------- | -------------------------------------------------- | ------------------- | -------------------- |
| `Content-Security-Policy`   | `'self'` + `challenges.cloudflare.com` (Turnstile) | `'self'` sahaja     | `default-src 'none'` |
| `frame-ancestors`           | `'none'`                                           | `'none'`            | `'none'`             |
| `Strict-Transport-Security` | 1 tahun, subdomain                                 | sama                | sama                 |
| `X-Content-Type-Options`    | `nosniff`                                          | sama                | sama                 |
| `Referrer-Policy`           | `strict-origin-when-cross-origin`                  | sama                | `no-referrer`        |
| `Cache-Control`             | `/assets/*` immutable                              | `no-store`          | `no-store`           |
| `X-Robots-Tag`              | —                                                  | `noindex, nofollow` | —                    |

✅ Disahkan di `wrangler dev`. ⚠️ CSP Turnstile belum diuji dengan widget sebenar (hos
disekat dalam sesi pembangunan); sahkan di staging.

✅ **Tiada `innerHTML`** dalam `apps/web` (ESLint). HTML dijana pada masa build melalui
templat yang meng-escape setiap nilai.

## Log

✅ Logger berstruktur meredaksi data mengikut kunci (nama, telefon, emel, token, alamat,
nota, `ipHash`…) dan mengikut nilai (emel, nombor telefon, JWT, Bearer, private key,
rentetan legap panjang). Rekod dikenal pasti dengan ID sahaja. Ujian snapshot membuktikan
tiada PII yang ditanam sampai ke output.

## Privasi (PDPA)

- **Tiada salinan atau foto MyKad, dan tiada nombor IC penuh.** Hanya 4 digit akhir (Fasa 2).
- ✅ Persetujuan borang direkod dengan versi notis privasi dan masa (dari pelayan).
- ✅ IP tidak pernah disimpan mentah; telefon disimpan untuk dihubungi, dengan hash untuk
  had kadar.
- ✅ Data di Cloudflare D1, rantau Asia Pasifik; notis privasi menyatakannya.
- ⚠️ PDPA s.7(3): notis privasi perlu dalam BM **dan Inggeris**. Draf semasa BM sahaja.
- ⚠️ Tempoh simpanan rekod kewangan: **perlu disahkan dengan akauntan**.
- Audit log merekod nama medan yang berubah, bukan nilainya.
- ✅ Fasa 2: MyKad — 4 digit terakhir sahaja, dengan pengesah dan masa (CHECK dalam D1);
  tiada salinan atau foto. Foto serahan ialah foto kamera, dalam R2 peribadi, dipadam
  `retention.photoDays` selepas tempahan ditutup (ADR-025).
- ✅ Token status tempahan tidak disimpan; hanya SHA-256 (ADR-023). Paparan status tidak
  mengandungi nama, telefon atau emel.
- ✅ Pemproses data baharu dinyatakan dalam notis privasi: CHIP (bayaran), Resend (emel).
- ✅ Emel yang dihantar dan rekod webhook dipadam selepas 90 hari.

## Risiko terbuka

| Risiko                                                    | Mitigasi / status                                                 |
| --------------------------------------------------------- | ----------------------------------------------------------------- |
| Access belum diuji dengan akaun sebenar                   | Semakan pertama selepas deploy staging                            |
| Pepijat kod Worker                                        | Kekangan D1 sebagai lapisan kedua; ujian; semakan setiap fasa     |
| Kandungan undang-undang ialah draf                        | Build production ditolak sehingga disahkan                        |
| Tindakan GitHub dirujuk dengan tag major, bukan SHA       | Pin ke SHA sebelum production                                     |
| URL CSV rahsia untuk Google Sheet (jika dipilih, ADR-019) | Belum dibina; perlu keputusan pemilik                             |
| Callback CHIP palsu                                       | Tandatangan RSA + pembelian dibaca semula dari API (ADR-022)      |
| Tarikh "disorok" oleh tahanan tanpa bayar                 | Turnstile, 5/10 min setiap IP & telefon, maks 2 tahanan terbuka   |
| Kunci ujian CHIP di production                            | Hold menolak pembelian `is_test` di production dan membatalkannya |
| EXIF/GPS dalam foto serahan                               | Admin sahaja; jangan kongsi foto keluar tanpa membuang EXIF       |
