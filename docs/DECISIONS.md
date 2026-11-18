# Keputusan Seni Bina (ADR)

Rekod ringkas setiap keputusan teknikal: apa yang diputuskan, sebab, dan apa yang ditolak.
Jika sesuatu di sini bercanggah dengan `CLAUDE_CODE_MASTER_PROMPT.md`, **dokumen ini yang
terpakai** — ia mencatat apa yang disahkan melalui percubaan sebenar.

Status: ✅ muktamad · ⏳ menunggu kelulusan pemilik · 📌 dicatat, dilaksana fasa kemudian ·
🔁 digantikan (disimpan untuk sejarah)

> **18 Nov 2026 — stack bertukar.** Atas permintaan pemilik ("sistem simple"), Firebase
> digantikan dengan **Cloudflare D1** (data) dan **Cloudflare Access** (log masuk admin).
> Semuanya kini dalam satu akaun Cloudflare. Lihat ADR-017, 018 dan 019. ADR yang bertanda 🔁
> menerangkan reka bentuk Firebase sebelum ini.

| #   | Keputusan                                                     | Status       |
| --- | ------------------------------------------------------------- | ------------ |
| 001 | Firestore melalui REST + Web Crypto, bukan `firebase-admin`   | 🔁 017       |
| 002 | Kunci slot: satu rekod per unit per hari, satu transaksi      | ✅ (D1: 017) |
| 003 | Tiada client akses pangkalan data terus; admin melalui Worker | ✅           |
| 004 | MFA admin                                                     | ✅ 018       |
| 005 | Pelan & anggaran kos                                          | ⏳           |
| 006 | Alat ujian dan versi yang dipin                               | ✅           |
| 007 | Rate limiting dua lapis                                       | ✅           |
| 008 | Satu Cron Trigger, agihan dalam kod                           | 📌 Fasa 2    |
| 009 | Header keselamatan aset statik                                | ✅           |
| 010 | Codec Firestore menolak nombor bukan integer                  | 🔁 017       |
| 011 | Cache kunci/token: nilai sahaja, tidak pernah promise         | ✅           |
| 012 | `ABORTED` sentiasa dicuba semula                              | 🔁 017       |
| 013 | Log masuk admin melalui Worker + sesi Worker sendiri          | 🔁 018       |
| 014 | Data lead: hash telefon & IP, persetujuan berversi            | ✅           |
| 015 | Laman dijana pada masa build daripada settings; pengawal draf | ✅           |
| 016 | `grant-admin` berjalan terus dengan Node                      | 🔁 018       |
| 017 | Cloudflare D1 sebagai pangkalan data                          | ✅           |
| 018 | Cloudflare Access untuk log masuk admin                       | ✅           |
| 019 | Google Sheet: paparan sahaja, belum dibina                    | ⏳           |

---

## ADR-001 — Firestore melalui REST + Web Crypto 🔁

**Keputusan.** Worker bercakap dengan Firestore melalui REST API
(`https://firestore.googleapis.com/v1/...`). Ia menandatangani JWT service account dengan
`crypto.subtle` (RS256), menukarnya di `https://oauth2.googleapis.com/token` untuk access
token berumur sejam, dan cache token itu dalam memori isolate.

**Bukti** (wrangler 4.160.0, workerd lokal, Firestore emulator, 10 Nov 2026):

| Percubaan                                                             | Keputusan                                                                                                          |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `firebase-admin@14.5.0` dengan flag `nodejs_compat`                   | **Gagal ketika startup**: `Uncaught ReferenceError: __dirname is not defined` dalam `google-gax/build/src/grpc.js` |
| Tandatangan JWT RS256 dengan `crypto.subtle` dalam workerd            | Lulus; tandatangan disahkan semula oleh Node `crypto`                                                              |
| `:commit`, `:batchGet`, `:runQuery`, `:beginTransaction`, `:rollback` | Semua berfungsi                                                                                                    |

**Ditolak.** `firebase-admin` (tidak boleh dimuatkan langsung). Firebase client SDK dalam
Worker (direka untuk pengguna akhir, tertakluk kepada Security Rules).

**Akibat.** Kita menyelenggara klien kecil sendiri (`apps/worker/src/lib/firestore.ts`,
`firestoreValues.ts`, `googleAuth.ts`). Ia diuji terhadap emulator dalam workerd.

**Belum disahkan.** Pertukaran token OAuth sebenar dengan Google memerlukan service
account sebenar. Penandatanganan dan bentuk permintaan diuji; pengesahan hujung-ke-hujung
dibuat semasa deploy staging pertama (Fasa 1).

---

## ADR-002 — Kunci slot: dokumen-per-hari dalam SATU commit atomik

**Konteks.** Firestore tiada exclusion constraint. Master prompt §6 mencadangkan dua corak
dan meminta kedua-duanya dinilai:

- **Corak A** — cipta dokumen hari satu demi satu, rollback jika mana-mana gagal
  ("best-effort atomicity").
- **Corak B** — satu dokumen ringkasan per unit, dikemas kini dalam satu transaction.

Master prompt mengandaikan REST tidak membenarkan berbilang `create` ber-precondition
dalam satu panggilan. **Andaian itu tidak tepat.**

**Keputusan — "Corak C".** Kekalkan skema `availabilityLocks/{unitId}_{yyyy-MM-dd}`
(satu dokumen per unit per hari), tetapi cipta **semua** hari bagi satu tempahan dalam
**satu** panggilan `:commit`, setiap write dengan `currentDocument.exists = false`,
bersama-sama dokumen `bookings` dan `bookingEvents` tempahan itu.

**Bukti.**

- Dokumen discovery rasmi Firestore, `CommitRequest.writes`:
  _"The writes to apply. Always executed atomically and in order."_
  `Write.currentDocument`: _"The write will fail if this is set and not met by the target
  document."_
- Ujian emulator: commit 3 hari + booking yang bertindih 1 hari dengan kunci sedia ada →
  `409 ALREADY_EXISTS`, **sifar tulisan separa** (tiada kunci, tiada booking).
- Ujian perlumbaan (`apps/worker/test/integration/availabilityLocks.test.ts`): 20
  permintaan serentak bertindih × 50 pusingan → tepat 1 pemenang setiap pusingan, tiada
  kunci yatim, tiada booking yatim. Dijalankan pada setiap CI.

**Perbandingan.**

|                                                              | A: berjujukan + rollback | B: dokumen ringkasan | **C: satu commit atomik** |
| ------------------------------------------------------------ | ------------------------ | -------------------- | ------------------------- |
| Atomicity                                                    | Tidak (best-effort)      | Ya                   | **Ya**                    |
| Kunci yatim jika Worker mati di tengah                       | Mungkin                  | Tidak                | **Tidak**                 |
| Dua permintaan berselang sama-sama gagal walaupun slot bebas | Mungkin                  | Tidak                | **Tidak**                 |
| Booking + kunci dalam satu operasi                           | Tidak                    | Perlu transaction    | **Ya**                    |
| Concurrency antara unit                                      | Baik                     | Bersiri per unit     | **Baik**                  |
| Kod rollback                                                 | Perlu                    | Tiada                | **Tiada**                 |

**Akibat.**

1. **Melepaskan kunci = memadam dokumen.** Tiada field `active`. Kewujudan dokumen ialah
   kunci itu sendiri, supaya `exists=false` kekal satu-satunya sumber kebenaran.
   (Menyimpang daripada §4 yang menyenaraikan field `active`.)
2. Tugas harian "padam kunci tidak aktif > 30 hari" (§6) menjadi "padam kunci bertarikh
   lebih 30 hari lalu".
3. `acquireDayLocks` selamat diulang: jika pemilik yang sama sudah memegang semua hari
   (contoh: respons commit pertama hilang), ia memulangkan `alreadyHeld`.
4. `releaseDayLocks` hanya memadam kunci milik pemilik yang diberi, dalam transaction,
   jadi pelepasan lewat atau berulang tidak boleh membebaskan hari tempahan lain.
5. Had: ≤ 60 hari setiap kunci (`MAX_LOCK_DAYS`), jauh di bawah had 500 write per commit.
6. **Kekasaran peringkat hari** (ikut §5): satu unit hanya boleh digunakan oleh satu
   tempahan pada satu hari kalendar. Lihat nota penggunaan unit dalam
   `BOOKING_AND_INVENTORY_LOGIC.md`.

**Untuk Fasa 2.** Hold yang sudah tamat tetapi belum dibersihkan cron: apabila kunci
gagal kerana hold tamat, jalankan fungsi pembatalan-hold yang sama dengan cron untuk
tempahan itu, kemudian cuba kunci sekali lagi. Satu laluan kod, tiada logik ambil-alih
berasingan.

---

## ADR-003 — Bacaan admin melalui Worker; Security Rules deny-all

> **Selepas ADR-017:** prinsipnya kekal — tiada client membaca atau menulis pangkalan data
> terus; semua melalui `/api/*`. D1 tidak boleh dicapai dari browser langsung, jadi tiada
> "rules" untuk dikonfigurasi.

**Konteks.** §10 membenarkan dua pendekatan untuk bacaan admin dan meminta satu dipilih
secara konsisten: client SDK + rules, atau `GET /api/admin/*`.

**Keputusan.** Semua bacaan admin melalui Worker. `firestore.rules` dan `storage.rules`
ialah `allow read, write: if false` untuk semua orang, termasuk admin yang log masuk.

**Sebab.**

- Satu lapisan penguatkuasaan dan audit, bukan dua model keselamatan untuk diselaraskan.
- Rules deny-all mustahil tersalah konfigurasi; tiada `allow` untuk disemak.
- Worker boleh membentuk respons (baki deposit, gabungan booking + ledger + events).
- Bundle admin tidak perlu Firestore SDK; CSP `connect-src` kekal sempit.

**Trade-off.** Tiada kemas kini realtime; admin memuat semula atau polling. Boleh
diterima untuk operator tunggal. Lebih banyak endpoint `GET` untuk ditulis.

**Menyimpang daripada.** Bullet Fasa 0 "tolak semua akses client kecuali bacaan admin" dan
item ujian "Security Rules benarkan bacaan admin". Ujian rules kini membuktikan sebaliknya:
admin pun ditolak (`firebase/test/rules.test.ts`, 225 ujian).

---

## ADR-004 — MFA admin ✅ (diselesaikan oleh ADR-018)

**Cadangan: (a) naik taraf ke Identity Platform dan wajibkan TOTP.**

- Firebase Authentication asas tidak menyokong TOTP; naik taraf ke Identity Platform
  diperlukan.
- Untuk 1–2 akaun admin, kos dijangka **RM0** (jauh di bawah had percuma).
  ⚠️ Angka had percuma diperoleh daripada sumber sekunder kerana halaman harga rasmi
  disekat dalam sesi pembangunan ini. **Sahkan di halaman harga rasmi Google sebelum
  enable.**
- Jika (a) ditolak, fallback (b): kata laluan kukuh, had percubaan log masuk di Worker,
  amaran email untuk log masuk dari IP baharu, sesi pendek.

**Kemas kini Fasa 1.** Mitigasi (b) yang tidak bergantung pada email **sudah dilaksana**:
had cubaan log masuk (10 / 15 min per IP, 5 / 15 min per emel), sesi maksimum 8 jam dan
tamat selepas 60 minit tidak aktif, audit setiap log masuk/keluar, dan kunci API Firebase
yang tidak pernah sampai ke browser (ADR-013). Amaran emel log masuk dari IP baharu
memerlukan outbox email (Fasa 2).

**Pilihan (c), timbul daripada ADR-013 — cadangan saya sekarang.** Kerana Worker sendiri
yang mengendalikan log masuk, ia boleh menguatkuasakan TOTP (RFC 6238, aplikasi
Authenticator) selepas kata laluan, tanpa Identity Platform dan tanpa kos. Kira-kira
50 baris Web Crypto + ujian; rahsia TOTP per admin disimpan sebagai Worker secret. Satu
aliran, satu tempat untuk diaudit. Kelemahan: kod MFA kita sendiri (walaupun standard
yang ringkas) berbanding perkhidmatan terurus.

**Tindakan pemilik:** pilih (a) Identity Platform, (c) TOTP dalam Worker, atau kekal
dengan mitigasi (b) buat sementara. Laman awam boleh dilancarkan tanpa keputusan ini;
panel admin sebaiknya tidak.

---

## ADR-005 — Pelan & anggaran kos ⏳

Selepas ADR-017/018 hanya satu akaun diperlukan: **Cloudflare**.

| Perkhidmatan        | Pelan                                                                       | Anggaran       |
| ------------------- | --------------------------------------------------------------------------- | -------------- |
| Workers             | **Paid (USD 5/bulan) disyorkan** untuk production; Free cukup untuk staging | USD 5          |
| D1                  | Termasuk; pelan percuma jauh melebihi keperluan                             | RM0            |
| Access (Zero Trust) | Free, sehingga 50 pengguna                                                  | RM0            |
| Turnstile           | Free                                                                        | RM0            |
| Domain              | Pendaftaran tahunan                                                         | ikut pendaftar |

**Kenapa Workers Paid.** Pelan Free menghadkan 10 ms CPU setiap permintaan. Pengesahan
JWT RSA, hash HMAC dan validasi zod boleh melepasi had itu sekali-sekala, dan webhook
bayaran (Fasa 2) yang gagal bukan risiko yang berbaloi untuk menjimatkan USD 5. Paid juga
memanjangkan D1 Time Travel daripada 7 kepada 30 hari.

Firebase Blaze **tidak lagi diperlukan**. Foto serahan (Fasa 2) akan menggunakan
Cloudflare R2, dengan peruntukan percuma 10 GB.

⚠️ Angka daripada sumber sekunder kerana halaman harga rasmi disekat dalam sesi ini;
sahkan sebelum production.

**Tindakan pemilik:** setuju dengan Workers Paid untuk production.
---

## ADR-006 — Alat ujian dan versi yang dipin

- **`@cloudflare/vitest-plugin`** menggantikan `@cloudflare/vitest-pool-workers` yang
  dinamakan dalam master prompt. Pakej lama telah **deprecated dan dinamakan semula**
  (README pakej itu sendiri). Ujian Worker berjalan dalam workerd, runtime yang sama
  dengan production.
- **Vitest 5.1**, `@vitest/coverage-v8` untuk gate coverage 90% pada `packages/shared`.
- **TypeScript dipin `~6.0.3`**: `typescript-eslint@8.72` belum menyokong TypeScript 7
  (peer range `<6.1.0`). Naik taraf apabila ia menyokong.
- **`@firebase/rules-unit-testing`** + **Firebase Emulator Suite** untuk ujian rules.

---

## ADR-007 — Rate limiting dua lapis

Workers Rate Limiting binding hanya menyokong tempoh **10 atau 60 saat** (skema
konfigurasi wrangler: `period: enum [10, 60]`). Had dalam §8 ("5 hold / 10 min",
"10 lead / jam") tidak boleh dinyatakan dengan binding sahaja.

**Keputusan.** (1) Binding `RL_BURST` (20 / 60 s per IP) sebagai barisan pertama yang
murah. (2) Kaunter tetingkap-tetap di Firestore untuk had sebenar.

**Pelaksanaan (Fasa 1).** `apps/worker/src/lib/rateLimit.ts`. Satu dokumen per kunci per
tetingkap (`rateLimits/{rule}_{hash}_{window}`), dinaikkan dengan transform `increment`
atomik; `commit` memulangkan nilai baharu, jadi satu semakan = satu round trip, satu
tulisan. Medan `expiresAt` dibersihkan oleh polisi TTL Firestore
(`firestore.indexes.json`). Kunci sentiasa hash (IP dan telefon tidak pernah menjadi ID
dokumen).

| Had                     | Nilai       |
| ----------------------- | ----------- |
| Lead per IP             | 10 / jam    |
| Lead per nombor telefon | 3 / hari    |
| Log masuk per IP        | 10 / 15 min |
| Log masuk per emel      | 5 / 15 min  |

Diuji termasuk penyerahan serentak (6 serentak untuk had 3 → tepat 3 lulus).
Lead dikira hanya selepas Turnstile lulus, supaya bot tanpa token tidak menelan kos
tulisan Firestore.

---

## ADR-008 — Satu Cron Trigger, agihan dalam kod 📌 Fasa 2

Pelan Free Cloudflare menghadkan 5 Cron Trigger **per akaun**; staging + production
dengan 5 jadual masing-masing melebihi had itu.

**Keputusan.** Satu trigger `* * * * *` setiap environment. Handler `scheduled` memilih
tugas mengikut masa (setiap minit, setiap 5 minit, 03:00 / 08:00 / 18:00 MYT) melalui
fungsi pure yang diuji.

---

## ADR-009 — Header aset statik

- Aset statik dihidang terus oleh Cloudflare tanpa melalui Worker, jadi header
  keselamatan mereka datang daripada `apps/web/public/_headers` (disahkan berfungsi di
  `wrangler dev`). Respons API menetapkan header sendiri (`lib/http.ts`).
- `/admin/*` menggantikan CSP dengan versi lebih ketat (tiada Turnstile), `no-store` dan
  `X-Robots-Tag: noindex` (sintaks `! Header` untuk menanggalkan header umum, disahkan di
  `wrangler dev`). `/assets/*` di-cache selama setahun kerana nama fail ber-hash.
- Mekanisme `{{t:key}}` Fasa 0 digantikan oleh ADR-015.

---

## ADR-010 — Codec Firestore menolak nombor bukan integer 🔁

Semua nombor dalam skema ialah integer (sen, bilangan, hari, jam). `encodeValue` melempar
ralat untuk sebarang nombor bukan safe-integer, jadi float **tidak boleh** sampai ke
Firestore walaupun validasi di atasnya terlepas.

---

## ADR-011 — Cache token: nilai sahaja, tidak pernah promise

Access token dicache dalam `Map` peringkat modul sebagai nilai biasa. Promise refresh yang
sedang berjalan disimpan pada instance provider (satu per permintaan), **bukan** dikongsi
antara permintaan — di Workers, menunggu promise milik permintaan lain boleh tergantung.

---

## ADR-012 — `ABORTED` sentiasa dicuba semula 🔁

Apabila beberapa commit menyentuh dokumen yang sama serentak, Firestore boleh menjawab
`ABORTED` (dalam emulator: "Transaction lock timeout" selepas 2 s) dan bukannya jawapan
precondition. `ABORTED` bermaksud **tiada apa-apa ditulis** dan tidak berkata apa-apa
tentang precondition. `Firestore.commit` dan `runTransaction` mencuba semula secara
automatik (backoff berjitter), jadi pemanggil sentiasa mendapat jawapan muktamad seperti
`ALREADY_EXISTS`. Ditemui melalui ujian idempotency webhook (10 create serentak).

---

## ADR-013 — Log masuk admin melalui Worker, dengan sesi Worker sendiri 🔁

**Konteks.** Master prompt mencadangkan browser log masuk dengan Firebase Auth SDK dan
menghantar ID token ke Worker pada setiap permintaan.

**Keputusan.** Browser menghantar emel + kata laluan ke `POST /api/admin/session`. Worker
memanggil Identity Toolkit `accounts:signInWithPassword`, mengesahkan ID token (RS256,
JWKS Google, issuer, audience, expiry, `admin === true`) dengan `jose`, kemudian
mengeluarkan **sesinya sendiri**: token rawak 256-bit dalam cookie `__Host-`,
`HttpOnly`, `Secure`, `SameSite=Strict`. Firestore hanya menyimpan SHA-256 token itu
(`adminSessions/{hash}`).

**Kenapa.**

- **Kunci API Firebase tidak pernah sampai ke browser.** Tiada orang lain boleh
  menggunakannya untuk mendaftar akaun, jadi "signup awam dimatikan" benar-benar
  dikuatkuasakan, bukan sekadar tiada butang.
- **Worker boleh mengehadkan cubaan log masuk** (mitigasi MFA (b)) — mustahil jika browser
  bercakap terus dengan Google.
- **Token tidak boleh dicuri oleh skrip** (HttpOnly), tidak seperti ID token dalam memori JS.
- **Sesi boleh ditamatkan serta-merta** (log keluar, `grant-admin --revoke`), dan pendek:
  8 jam mutlak, 60 minit tidak aktif.
- Bundle admin tiada Firebase SDK: 2.5 KB gzip; CSP `connect-src 'self'` sahaja.

**CSRF.** Cookie `SameSite=Strict`, setiap permintaan yang mengubah keadaan mesti membawa
`Origin` sama, dan badan mesti `application/json`.

**Akibat.** Pembatalan claim `admin` berkuat kuasa pada log masuk seterusnya; untuk
memotong sesi aktif, `grant-admin --revoke` memadam sesi akaun itu. Akaun dengan MFA
Identity Platform (jika diaktifkan kemudian) ditolak oleh aliran ini sehingga ia
disokong (`MFA_REQUIRED` dilog).

Endpoint dan medan disahkan daripada dokumen discovery rasmi Identity Toolkit.

---

## ADR-014 — Data lead: hash telefon & IP, persetujuan berversi

- Telefon dinormalkan ke E.164 (bimbit Malaysia sahaja, `+601…`) dan disimpan bersama
  `phoneHash` = HMAC-SHA256 dengan `PHONE_HASH_PEPPER`, berawalan tujuan (`phone:`), untuk
  had kadar dan pemadanan masa depan tanpa membaca nombor.
- **IP mentah tidak pernah disimpan.** Hanya HMAC (`ip:`), dan hanya dalam ID kaunter had
  kadar serta rekod sesi admin.
- Setiap lead merekod `consent: { privacyVersion, at }` daripada `settings.policyVersions`.
  Versi diambil dari pelayan, bukan dari browser.
- Medan bebas (nama, nota) menolak aksara kawalan; tiada input mentah dipantulkan dalam
  mesej ralat.
- Eksport CSV meneutralkan sel yang bermula dengan `= + - @ tab CR` (CSV injection).

---

## ADR-015 — Laman dijana pada masa build daripada settings; pengawal draf

**Keputusan.** Setiap halaman ialah fungsi TypeScript yang memulangkan HTML melalui
templat `html` yang meng-escape setiap nilai; plugin Vite menjana dokumen penuh semasa
build. Harga, deposit, add-on, lokasi dan polisi dibaca daripada `DEFAULT_SETTINGS` —
objek yang sama digunakan oleh `quote()` di pelayan dan kalkulator di browser.

**Kenapa.** HTML statik: pantas di 4G, boleh diindeks, berfungsi tanpa JS (kecuali borang
dan kalkulator). Tiada `innerHTML`. Angka di halaman tidak boleh bercanggah dengan harga
yang dikira. Lighthouse mobile tempatan: Performance / Accessibility / Best Practices 100.

**Had yang disedari.** Dalam Fasa 1, `settings/*` belum boleh disunting melalui UI, jadi
`DEFAULT_SETTINGS` ialah sumber tunggal dan menukar harga = suntingan kod + deploy. Apabila
UI settings tiba (Fasa 2), laman akan membaca `GET /api/pricing` (atau dibina semula
selepas perubahan settings).

**Pengawal draf.** Kandungan yang belum disahkan pemilik dibalut `draft()`. Build staging
memaparkan banner "DRAF" dan `noindex`. **Build production gagal** selagi ada draf, kunci
ujian Turnstile, atau `VITE_SITE_ORIGIN` tiada. Kandungan tekaan tidak boleh sampai ke
pelanggan secara tidak sengaja.

**Pemuat config Vite.** Kod build-time mengimport `shared` melalui laluan relatif
(`src/render/shared.ts`) kerana pemuat config Vite memuatkan pakej bare dengan Node biasa,
yang tidak dapat menyelesaikan import TypeScript tanpa sambungan. Kod browser kekal
menggunakan `@lensarent/shared/...`.

---

## ADR-016 — `grant-admin` berjalan terus dengan Node 🔁

Skrip menggunakan type stripping Node 22.18+ (tiada `tsx`, tiada build) dan mengimport
`googleAuth.ts` / `identityToolkit.ts` Worker terus — kedua-dua fail hanya menggunakan
sintaks TypeScript yang boleh dibuang dan tiada import relatif tanpa sambungan. Ia
menetapkan/menarik balik claim melalui Identity Toolkit Admin REST, dan `--revoke` juga
memadam sesi admin akaun itu. Diuji terhadap emulator Auth + Firestore.

---

## ADR-017 — Cloudflare D1 sebagai pangkalan data

**Konteks.** Pemilik mahu sistem yang lebih ringkas dan mencadangkan Google Sheet. Sheet
ditolak sebagai pangkalan data utama: tiada penulisan atomik (dua pelanggan boleh menempah
hari yang sama), sel boleh disunting tanpa jejak, kuota API, dan risiko perkongsian fail
yang mengandungi data peribadi. Pemilik bersetuju dengan Pilihan C: D1 + Access.

**Keputusan.** Data dalam **Cloudflare D1** (SQLite terurus), dicipta dengan
`--location apac`. Skema dalam `apps/worker/migrations/*.sql`, digunakan dengan
`wrangler d1 migrations apply`.

**Kenapa lebih baik daripada Firestore untuk bisnes ini.**

|                     | Firestore (dahulu)                              | D1 (sekarang)                                                   |
| ------------------- | ----------------------------------------------- | --------------------------------------------------------------- |
| Akaun               | Google Cloud + Cloudflare                       | Cloudflare sahaja                                               |
| Kelayakan           | Service account JSON, tandatangan JWT sendiri   | Binding `DB` — tiada kunci                                      |
| Kekangan            | Tiada; semua dalam kod                          | PRIMARY KEY, CHECK, trigger **sebagai lapisan kedua**           |
| Anti double-booking | `exists=false` setiap dokumen dalam satu commit | PRIMARY KEY `(unit_id, date)` dalam satu batch                  |
| Ujian               | Emulator Java, ~25 s                            | D1 tempatan dalam workerd, tiada pemasangan                     |
| Backup              | Export terurus (perlu Blaze)                    | Time Travel (7 hari Free / 30 hari Paid) + `wrangler d1 export` |

**Semantik yang disahkan.**

- `db.batch([...])` ialah satu transaksi SQL: jika satu statement gagal, semuanya
  di-rollback (dokumentasi D1, dipetik dalam sumber sekunder; **diuji terus** dalam
  `test/integration/database.test.ts`).
- Perangkap: UPDATE/DELETE yang tidak menjejaskan sebarang baris **bukan** kegagalan,
  jadi batch tetap commit. Statement yang mesti berlaku bersama dikawal dengan syarat SQL
  (contoh: audit dimasukkan `WHERE EXISTS` lead itu).
- Pelanggaran PRIMARY KEY/UNIQUE dikesan oleh `isUniqueViolation` (diuji).
- Ujian perlumbaan 20 permintaan × 50 pusingan: tepat seorang pemenang setiap pusingan,
  tiada baris separa.

**Akibat.**

- ADR-001 (REST Firestore), 010 (codec), 012 (`ABORTED`) tidak lagi relevan.
- Masa disimpan sebagai rentetan ISO-8601 UTC (boleh disusun, mudah dibaca di konsol D1).
- Kunci dilepaskan dengan DELETE (sama seperti ADR-002).
- `webhook_events`, `receipt_counters`, `ledger_entries` (dengan trigger append-only) dan
  jadual tempahan ditambah dalam migrasi Fasa 2.
- Had pelan percuma D1 (5 juta baris dibaca / 100 ribu ditulis sehari, 500 MB setiap
  pangkalan data) jauh melebihi keperluan. ⚠️ Daripada sumber sekunder; sahkan di
  halaman harga rasmi.

---

## ADR-018 — Cloudflare Access untuk log masuk admin

**Keputusan.** Aplikasi Cloudflare Access melindungi `/admin/*` dan `/api/admin/*`. Admin
log masuk dengan **kod sekali guna (OTP) ke emel** atau akaun Google; Access hanya
menghantar kod kepada emel yang dibenarkan oleh polisinya.

**Pertahanan berlapis.** Worker **tidak** bergantung pada konfigurasi Access sahaja. Setiap
permintaan admin:

1. mesti membawa header `Cf-Access-Jwt-Assertion` (bukan cookie — Cloudflare mengesyorkan
   header kerana cookie tidak dijamin dihantar);
2. JWT disahkan dengan `jose`: tandatangan RS256 terhadap kunci pasukan di
   `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, issuer pasukan, audience =
   tag AUD aplikasi, tamat tempoh;
3. emel mesti ada dalam `ADMIN_EMAILS` Worker;
4. permintaan yang mengubah data mesti dari origin sendiri (CSRF).

Laluan yang tersalah konfigurasi atau URL `workers.dev` tanpa Access → **401**. Kunci
dicache sebagai nilai (ADR-011) dan diambil semula sekali apabila Cloudflare memutar kunci.

**Kesan.**

- **MFA (ADR-004) selesai**: OTP emel ialah faktor kedua berasaskan akses peti emel, dan
  boleh diperketat dalam polisi Access (contoh: wajibkan Google dengan 2FA) tanpa kod.
- Dibuang: log masuk Firebase, sesi Worker, had cubaan log masuk, `grant-admin`.
  Menambah/membuang admin = ubah polisi Access **dan** `ADMIN_EMAILS`.
- Log keluar: `/cdn-cgi/access/logout`.
- Pembangunan tempatan: `ACCESS_DEV_EMAIL` (ditolak oleh Worker di staging/production).
- Pelan percuma Zero Trust: sehingga 50 pengguna. ⚠️ Sumber sekunder; sahkan.
- ⚠️ Belum diuji dengan Access sebenar (perlukan akaun). Semakan pertama selepas deploy staging.

---

## ADR-019 — Google Sheet sebagai paparan sahaja ⏳

Pemilik suka melihat data dalam Sheet. D1 kekal sumber kebenaran; Sheet hanya cermin.

**Sekarang:** panel admin → "Eksport CSV" → buka atau import dalam Google Sheets.

**Belum dibina (perlu keputusan):** penyegerakan automatik. Pilihan paling ringkas ialah
URL CSV rahsia (token panjang, boleh ditukar) yang dibaca oleh `IMPORTDATA` dalam Sheet.
Trade-off: sesiapa yang memegang URL itu boleh membaca nama dan telefon pelanggan. Ia
tidak dilindungi Access kerana pelayan Google yang mengambilnya. Pilihan lain (Sheets API)
memerlukan semula service account Google, bertentangan dengan matlamat "Cloudflare sahaja".

---

## Dependency & justifikasi

| Pakej                                                                                           | Di mana        | Sebab                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `zod`                                                                                           | shared, worker | Validasi input & settings; satu-satunya dependency runtime Fasa 0                                                                                                                        |
| `typescript`, `eslint`, `typescript-eslint`, `@eslint/js`, `eslint-config-prettier`, `prettier` | root (dev)     | TS strict, lint, format                                                                                                                                                                  |
| `vitest`, `@vitest/coverage-v8`                                                                 | dev            | Ujian + gate coverage                                                                                                                                                                    |
| `@cloudflare/vitest-plugin`                                                                     | worker (dev)   | Jalankan ujian dalam workerd                                                                                                                                                             |
| `wrangler`, `@cloudflare/workers-types`                                                         | worker (dev)   | Dev lokal, deploy, jenis runtime                                                                                                                                                         |
| `vite`                                                                                          | web (dev)      | Build laman statik                                                                                                                                                                       |
| `firebase-tools`                                                                                | root (dev)     | Emulator Suite, deploy rules                                                                                                                                                             |
| `@firebase/rules-unit-testing`, `firebase`                                                      | firebase (dev) | Ujian Security Rules                                                                                                                                                                     |
| `jose`                                                                                          | worker         | Pengesahan JWT Cloudflare Access (RS256 + JWKS). Kod kritikal keselamatan: pustaka yang diuji luas, tanpa dependency, berasaskan Web Crypto; contoh rasmi Cloudflare juga menggunakannya |

Dibuang pada 18 Nov 2026: `firebase-tools`, `firebase`, `@firebase/rules-unit-testing`.

**Nota saiz.** Bundle Worker ≈ 851 KiB (142 KiB gzip), kebanyakannya zod dan jose. Jauh di bawah
had; jika perlu dikecilkan kemudian, `zod/mini` ialah pilihan.

---

## Sumber yang disahkan

| Perkara                                                                        | Sumber                                                                                                     |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Semantik `commit` / `Precondition` / `batchWrite` / `exportDocuments`          | Dokumen discovery rasmi: `https://firestore.googleapis.com/$discovery/rest?version=v1`                     |
| Konfigurasi static assets, `run_worker_first`, `ratelimits`, `triggers`        | `node_modules/wrangler/config-schema.json` (wrangler 4.160.0)                                              |
| Sokongan fail `_headers`                                                       | Diuji di `wrangler dev`                                                                                    |
| Keserasian `firebase-admin`                                                    | Percubaan langsung (ADR-001)                                                                               |
| Atomicity dan tingkah laku perlumbaan                                          | Ujian emulator (ADR-002)                                                                                   |
| `signInWithPassword`, `accounts:lookup`, `accounts:update`, `customAttributes` | Dokumen discovery rasmi: `https://identitytoolkit.googleapis.com/$discovery/rest?version=v1`               |
| JWKS ID token Firebase                                                         | `https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com` (diambil, 200) |
| Polisi TTL dalam `fieldOverrides`                                              | Validator `firebase-tools` sendiri (`FirestoreApi.validateSpec`)                                           |
| Kunci ujian Turnstile (`1x00000000000000000000AA` dsb.)                        | Kunci ujian yang didokumenkan Cloudflare; **siteverify tidak dapat dicapai dari sesi ini**                 |

**Tidak dapat dibaca terus dalam sesi ini** (hos disekat polisi rangkaian):
`developers.cloudflare.com`, `firebase.google.com`, `docs.chip-in.asia`. Fasa 0 tidak
bergantung padanya. **Fasa 2 memerlukan dokumentasi CHIP** — hos perlu dibenarkan ketika
itu.

---

## Tafsiran domain yang menunggu pengesahan pemilik

Semua ini nilai dalam `settings/*` (boleh diubah tanpa deploy), ditanda `TO CONFIRM` dalam
`packages/shared/src/defaultSettings.ts`:

1. **Jadual slot serahan** — kosong; tidak diteka.
2. **Add-on lens RM5** — dicaj sekali setiap tempahan (bukan sehari), maksimum 1 setiap
   jenis.
3. **`holdMinutes`** — 15 minit (tiada nilai dalam master prompt).
4. **Had caj lewat 24 jam** — RM69 (kadar 1 hari). Dengan RM15 × 4 blok = RM60, had ini
   tidak pernah tercapai pada nilai semasa.
5. **Buffer peak** — 24 jam terpakai apabila _tarikh pemulangan_ jatuh dalam `peakPeriods`.
6. **Yuran meetup** — yuran lokasi pickup + yuran lokasi pemulangan (kedua-duanya RM0
   sekarang).
7. **Sempadan pembatalan** — `> 72 jam` refund penuh; `24–72 jam` inklusif; `< 24 jam`
   lucut RM30.
