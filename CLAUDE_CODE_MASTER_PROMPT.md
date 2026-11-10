# CLAUDE CODE MASTER PROMPT — Sistem Tempahan Sewaan DJI Osmo Pocket 4P

> Versi: 2.0 · Tarikh: 10 Nov 2026 · Pemilik: Taufiq
> Stack muktamad: **Firebase (Firestore, Authentication, Cloud Storage) + Cloudflare (Workers + Static Assets, DNS, Turnstile, Web Analytics, R2 untuk backup)**
> Bahasa UI pelanggan: **Bahasa Melayu** (wajib — CPETTR 2024). Kod, identifier & komen dalam English.
> Jenama: **LensaRent**

---

## 0. PERANAN & CARA KERJA

Anda ialah senior full-stack engineer + security engineer. Tugas anda: membina sistem tempahan sewaan kamera yang **production-ready, ringkas dan selamat**.

Peraturan kerja:

1. **Mulakan dalam plan mode.** Baca keseluruhan dokumen ini, kemudian bentangkan pelan Fasa 0 sebelum menulis kod.
2. **Bina mengikut fasa (Seksyen 3).** Selepas setiap fasa: jalankan semua ujian, kemas kini dokumentasi, beri ringkasan (apa yang dibina, keputusan, risiko, langkah ujian manual), kemudian **BERHENTI dan tunggu kelulusan saya**.
3. **Jangan teka keputusan bisnes.** Nilai bisnes (harga, deposit, slot, polisi) disimpan dalam dokumen `settings/*` di Firestore, bukan di-hardcode. Guna nilai awal dalam Seksyen 5.
4. Prinsip: **KISS, YAGNI, DRY, secure by default, minimal dependencies, native APIs.** Setiap dependency baharu mesti dijustifikasi dalam `docs/DECISIONS.md`.
5. **Integriti data ditegakkan di lapisan Worker, bukan di Firestore.** Ini **perbezaan kritikal** berbanding Postgres: Firestore Security Rules **tidak terpakai** kepada akses Admin SDK/REST dengan service account (akses sedemikian memintas semua rules). Oleh itu Cloudflare Worker — bukan Firestore — ialah **satu-satunya lapisan penguatkuasaan** bagi anti double-booking, state machine dan ledger immutable. Setiap mutasi admin mesti disahkan dalam kod Worker sebelum ditulis.
6. **Domain logic dahulu:** pricing, tempoh, overlap dan state machine ditulis sebagai pure functions + unit test **sebelum** UI.
7. Jika API pihak ketiga (CHIP, Firebase, Cloudflare) tidak pasti, **baca dokumentasi rasmi terkini** dan catat apa yang disahkan dalam `docs/DECISIONS.md`. Jangan andaikan — khususnya **sahkan keserasian Firebase Admin SDK dengan Cloudflare Workers runtime** (lihat Seksyen 2, amaran) sebelum teruskan ke Fasa 0.
8. Cipta dan kekalkan `CLAUDE.md` di root: konvensyen, arahan run/test/deploy, dan peraturan domain kritikal (ringkas).
9. **Rujukan dalaman:** saya ada projek berkaitan (TeratakHub — Supabase + Cloudflare Workers + CHIP). Jika saya beri akses repo itu, kaji corak CHIP adapter dan struktur Worker sahaja (bukan lapisan data — TeratakHub guna Postgres, sistem ini guna Firestore). **Jangan kongsi project Firebase/Supabase** — sistem ini berdiri sendiri, single-tenant.

**Bukan skop MVP (jangan bina):** multi-tenant, marketplace, akaun/login pelanggan, native app, WhatsApp Business API, ansuran, sewaan > 7 hari, penghantaran kurier, eKYC.

---

## 1. KONTEKS BISNES (RINGKAS)

- Sewaan DJI Osmo Pocket 4P di utara Semenanjung (Parit Buntar, Bandar Baharu, Nibong Tebal). Bermula dengan **1 unit**; sistem mesti menyokong N unit tanpa rewrite.
- Operator tunggal bekerja sepenuh masa → serahan/pemulangan hanya dalam **slot tetap**.
- Pelanggan menempah sebagai tetamu (tanpa akaun) dan mendapat pautan status melalui token rahsia.
- Pembayaran online melalui **CHIP** (FPX, DuitNow QR, kad), di belakang adapter supaya boleh tukar ke Billplz.
- **Deposit keselamatan bukan hasil.** Ia direkod berasingan sebagai liabiliti. Pemulangan deposit (MVP) dibuat manual oleh admin melalui DuitNow, kemudian direkod dalam ledger.
- **JANGAN simpan salinan/foto MyKad** dalam sistem ini. Rekod hanya 4 digit akhir IC + siapa mengesahkan + bila. (Nota: salinan fizikal MyKad untuk borang sewaan kertas diuruskan secara berasingan di luar sistem ini, mengikut dasar privasi perniagaan sedia ada.)
- Jenama: **LensaRent**. Domain belum muktamad → guna placeholder `{{DOMAIN}}` dari config.

---

## 2. STACK & SENIBINA (MUKTAMAD)

| Lapisan | Pilihan | Nota |
|---|---|---|
| Frontend | **Vite + TypeScript (strict)**, tanpa UI framework, plain CSS (custom properties) | Mobile-first. Kalendar dibina sendiri. |
| Hosting + API | **Satu Cloudflare Worker** dengan **Static Assets** (bina dari `apps/web`) + route `/api/*` | Same-origin → tiada CORS. |
| Database | **Firebase Firestore (Native mode)**, lokasi **`asia-southeast1` (Singapura)** | Model dokumen/koleksi, bukan relational. Lihat Seksyen 4 untuk reka bentuk. |
| Logik kritikal | **Kod dalam Cloudflare Worker**, menulis ke Firestore melalui **Firestore REST API** dengan token OAuth2 service account ditandatangani guna **Web Crypto** (`crypto.subtle`) | **AMARAN WAJIB SAHKAN DAHULU:** `firebase-admin` (Node SDK rasmi) bergantung pada gRPC/Node API dan **secara amnya tidak serasi** dengan Workers V8 isolate runtime, walaupun dengan flag `nodejs_compat`. Sebelum Fasa 0 bermula, jalankan percubaan kecil: cuba `firebase-admin` dengan `nodejs_compat` di Worker tempatan. Jika gagal (jangkaan besar ia gagal), guna **Firestore REST API** terus (`https://firestore.googleapis.com/v1/...`) dengan JWT service account yang ditandatangani menggunakan Web Crypto — corak ini **disahkan berfungsi** di Workers. Catat keputusan dalam `docs/DECISIONS.md`. |
| Transaksi atomik | **Firestore transactions** (`runTransaction` melalui REST `:commit` dengan `currentDocument.exists`/`updateTime` precondition) | Gantian kepada Postgres transaction + exclusion constraint. Lihat Seksyen 6 untuk corak kunci slot. |
| Auth | **Firebase Authentication** — admin sahaja (email/password) | Signup awam dimatikan (tiada endpoint signup didedahkan). **MFA (TOTP) memerlukan naik taraf ke Identity Platform** (kos tambahan) — sahkan keperluan ini dan dapatkan kelulusan saya sebelum enable, atau guna kawalan alternatif (rujuk Seksyen 8). |
| Storage | **Firebase Cloud Storage**, bucket/folder `handover/` | **Tiada akses awam.** Storage Security Rules tolak semua akses client; muat naik/turun foto **hanya** melalui Worker (guna REST API Cloud Storage + signed URL berumur pendek yang dijana Worker). |
| Jadual tugas | **Cloudflare Workers Cron Triggers** sahaja (tiada Cloud Functions — kekalkan satu platform compute) | Setiap cron job memanggil Firestore REST API terus daripada Worker. |
| Anti-bot | **Cloudflare Turnstile** (verify di Worker) + **Workers Rate Limiting binding** | |
| Email | Satu transactional email API (cadangan: Resend), melalui koleksi outbox | |
| Validasi | **zod** (shared web + Worker) | |
| Ujian | **Vitest** (`@cloudflare/vitest-pool-workers` untuk Worker) + **Firebase Emulator Suite** (Firestore + Auth + Storage emulator) + `@firebase/rules-unit-testing` untuk ujian Security Rules | Gantian kepada pgTAP. |
| DB tooling | **Firebase CLI**: `firebase emulators:start` untuk dev lokal, `firebase deploy --only firestore:rules,firestore:indexes,storage:rules`, `firestore.indexes.json` untuk composite index | |
| Monorepo | pnpm workspaces | |

**Nota penting tentang model keselamatan (baca dengan teliti):**
Firestore Security Rules **hanya** terpakai kepada akses terus dari client SDK (contoh: admin frontend membaca data terus). Akses melalui service account (Worker) **memintas semua rules**. Reka bentuk ini bermaksud:
- **Semua tulisan (write)** — tempahan, pembayaran, transition status, ledger — **mesti** melalui Worker API, yang menjalankan semua semakan (anti double-booking, state machine, baki deposit) secara manual dalam kod sebelum commit.
- **Bacaan (read) oleh admin frontend** boleh terus guna Firebase client SDK + Firestore Security Rules (`request.auth.token.admin == true`) untuk prestasi & realtime, **tetapi** ini hanya selamat kerana tiada write client didedahkan dalam rules (`allow write: if false;` global, kecuali spesifik yang benar-benar perlu).
- Jangan sekali-kali bina endpoint yang membenarkan client menulis terus ke Firestore tanpa melalui Worker.

**Larangan:**
- Jangan guna moment/dayjs. Guna `Date` + `Intl` dengan timezone `Asia/Kuala_Lumpur` (UTC+8, tiada DST — tetap guna helper).
- Jangan guna float untuk wang. Firestore simpan sebagai `integer` (sen); TS guna `number` integer yang disahkan zod.
- Service account key / Firebase Admin credentials **hanya** dalam Worker secrets. Tidak pernah dihantar ke frontend.
- Jangan simpan sebarang nilai sensitif (service account private key, CHIP key) dalam Firestore — Worker secrets sahaja.

### Struktur repo

```
/
├─ CLAUDE.md
├─ CLAUDE_CODE_MASTER_PROMPT.md
├─ apps/web/                  # Vite + TS (public site + /admin)
├─ apps/worker/               # Cloudflare Worker: /api/*, webhook, cron, static assets
│   ├─ wrangler.toml          # env: staging, production
│   └─ src/lib/firestore.ts   # klien REST Firestore + penandatangan JWT (Web Crypto)
├─ packages/shared/           # pure domain logic + zod schemas + types (tanpa dependency runtime)
│   ├─ pricing.ts  duration.ts  overlap.ts  stateMachine.ts  money.ts  time.ts  schemas.ts
├─ firebase/
│   ├─ firestore.rules        # Security Rules (bacaan admin sahaja; tulisan client ditolak)
│   ├─ firestore.indexes.json
│   ├─ storage.rules          # tolak semua akses client
│   └─ firebase.json
├─ scripts/                   # grant-admin (set custom claim), backup/restore helpers
├─ docs/                      # Seksyen 14
└─ .github/workflows/         # ci.yml, backup.yml
```

### Persekitaran

- **Dua projek Firebase:** `staging` dan `production`, plus dua Worker environment. Tiada data sebenar dalam staging.
- **Sahkan pelan Firebase (Spark vs Blaze) yang diperlukan.** Spark (percuma) mungkin mencukupi untuk Firestore+Auth+Storage pada peringkat awal, tetapi had kuota ketat dan tiada akses rangkaian luar dari mana-mana Cloud Function (tidak relevan di sini kerana tiada Cloud Functions digunakan). Catat keputusan + anggaran kos dalam `DECISIONS.md` dan **beritahu saya implikasi kos** sebelum production.
- Rahsia (Firebase service account JSON / private key, CHIP keys, email API key, Turnstile secret, `PHONE_HASH_PEPPER`, backup credentials) disimpan dalam `wrangler secret` / GitHub Secrets sahaja. Sediakan `.dev.vars.example` tanpa nilai.

---

## 3. FASA PEMBANGUNAN (BERHENTI SELEPAS SETIAP FASA)

### Fasa 0 — Asas (tiada UI awam)
- **Percubaan keserasian Firebase Admin SDK vs REST API di Workers (lihat Seksyen 2 amaran) — selesaikan dahulu sebelum apa-apa lain.** Catat keputusan dalam `DECISIONS.md`.
- Monorepo, TS strict, ESLint + Prettier, Vitest, Firebase CLI + emulator lokal, wrangler, CI (typecheck, lint, unit, ujian emulator).
- `packages/shared` siap dengan **coverage ≥ 90%**.
- `firebase/firestore.rules` asas: tolak semua akses client kecuali bacaan admin (`request.auth.token.admin == true`) pada koleksi yang dibenarkan; tolak semua tulisan client.
- Helper `apps/worker/src/lib/firestore.ts`: tandatangan JWT service account (Web Crypto), dapatkan access token OAuth2, wrapper `get`/`commit`/`runTransaction` melalui REST API.
- `CLAUDE.md`, `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`.

### Fasa 1 — Validasi permintaan (boleh dilancar segera)
- Landing page BM (Seksyen 11), halaman polisi, panduan, FAQ.
- Borang minat (`leads`) dengan Turnstile + rate limit: nama, telefon, tarikh diingini, kegunaan (dropdown), sumber (dari mana tahu).
- Butang CTA WhatsApp (`wa.me` dengan mesej pra-isi).
- Admin: login (Firebase Auth) + senarai leads (filter, export CSV, tukar status).
- Deploy staging → production.

### Fasa 2 — MVP Tempahan (hanya selepas saya beri GO)
- Ketersediaan + hold + anti double-booking (Seksyen 6).
- Pricing server-side, wizard tempahan, checkout CHIP, webhook, halaman status.
- Admin operasi: kalendar, tempahan, transition, checklist serahan/pemulangan, foto, ledger, rekod refund deposit, blok penyelenggaraan, unit, pelanggan, settings, audit log.
- Outbox email + pautan WhatsApp pra-isi + jadual tugas (hold expiry, overdue, ringkasan harian).
- Backup harian (export Firestore) + runbook restore yang **diuji**.
- Launch checklist (Seksyen 12) lulus.

### Fasa 3 — Pengoptimuman (kemudian)
- Laporan: hasil ikut jenis ledger, penggunaan unit (%), tempahan/bulan, ARPB, kadar tempahan semula, CAC (input manual kos pemasaran).
- Kod referral: RM10 kredit perujuk / RM10 diskaun rakan. Kredit diberi hanya selepas tempahan rakan `completed`.
- Automasi retention data (Seksyen 8).

---

## 4. SKEMA FIRESTORE

Peraturan umum:
- Semua wang dalam **integer sen** (field `*Sen`).
- Semua masa dalam **Firestore Timestamp**.
- ID dokumen: `auto-id` Firestore melainkan dinyatakan sebaliknya (beberapa koleksi guna ID deterministik untuk idempotency/locking — lihat nota).
- Setiap dokumen ada `createdAt` / `updatedAt` (ditulis oleh Worker, bukan client).
- **Tiada RLS seperti Postgres.** Validasi struktur & integriti dibuat di Worker (zod) sebelum tulis. Firestore Security Rules hanya mengawal bacaan client admin (lihat Seksyen 2).

| Koleksi | Kandungan utama | Nota |
|---|---|---|
| `settings/{key}` | Dokumen tunggal per kunci: `value` (map), `updatedBy`, `updatedAt`. Kunci: `pricing`, `addOns`, `meetupLocations`, `handoverSlots`, `depositTiers`, `buffer`, `peakPeriods`, `holdMinutes`, `minLeadHours`, `maxRentalDays`, `lateFee`, `cancellation`, `policyVersions`, `businessInfo`. | Disahkan zod di Worker sebelum ditulis. |
| `units/{unitId}` | `name, model, serialNumber, status` (`active`/`maintenance`/`retired`), `accessories: [{code,name,serial?,replacementPriceSen}]` | |
| `customers/{customerId}` | `phoneHash` (HMAC-SHA256(E.164, pepper), **index unik dikuatkuasakan oleh Worker** — semak wujud sebelum create), `name, phoneE164, email, tier` (`new`/`verified`/`returning`), `completedCount, blocked, notes` | Firestore tiada unique constraint native; Worker mesti query+create dalam transaction. |
| `bookings/{bookingId}` | `refCode` (pendek, rawak, index dikuatkuasakan Worker), `lookupTokenHash, unitId, customerId, customerSnapshot, pickupSlotId, pickupAt, pickupLocationId, returnSlotId, returnAt, returnSlotEnd, returnLocationId, rentalDays, addOns, priceBreakdown` (rentalSen/addOnsSen/meetupSen/discountSen/depositSen/totalPayableSen), `status, statusReason, holdExpiresAt, consent` (termsVersion, privacyVersion, at, ipHash), `verification` (idLast4, verifiedBy, verifiedAt), `handover, returnInspection, flags: []` | |
| `availabilityLocks/{unitId}_{yyyy-MM-dd}` | `unitId, date, kind` (`hold`/`booking`/`maintenance`), `bookingId` nullable, `holdExpiresAt` nullable, `active` | **ID deterministik** — satu dokumen per unit per hari. Ini ialah gantian kepada `inventory_blocks` + exclusion constraint Postgres. Lihat Seksyen 6. |
| `bookingEvents/{eventId}` | `bookingId, fromStatus, toStatus, actorId, actorType` (`system`/`admin`/`webhook`), `reason, at` | |
| `payments/{paymentId}` | `bookingId, provider, providerRef` (unik — Worker semak sebelum create), `kind, expectedSen, paidSen, currency, status, rawStatus, paidAt` | |
| `ledgerEntries/{entryId}` | `bookingId, type, amountSen` (bertanda), `method` (`gateway`/`duitnow`/`cash`), `reference, note, createdBy, createdAt` | **Immutable**: Security Rules tolak `update`/`delete` client (`allow update, delete: if false`); Worker juga tidak pernah memanggil update/delete ke koleksi ini — hanya `create`. Pembetulan = entri reversal baharu. |
| `webhookEvents/{provider}_{eventKey}` | `provider, eventKey, receivedAt, processedAt, result` | **ID deterministik** = kunci idempotency (REST `create` gagal jika dokumen wujud → dikesan sebagai duplicate). |
| `notificationsOutbox/{notificationId}` | `channel` (`email`), `template, toAddress, payload, status` (`pending`/`sent`/`failed`), `attempts, lastError, sendAfter, sentAt` | |
| `receiptCounters/{year}` | `lastNumber` (integer) | Penomboran resit berjujukan (contoh `R-2026-00001`), dikemas kini dalam Firestore transaction (`runTransaction`) untuk elak race condition. |
| `leads/{leadId}` | Fasa 1 | |
| `admins` | **Tiada koleksi** — status admin disimpan sebagai **Firebase custom claim** (`admin: true`) pada akaun Firebase Auth, ditetapkan melalui `scripts/grant-admin.ts` (guna Admin Auth REST API). | |
| `auditLogs/{logId}` | `actorId, action, targetCollection, targetId, changedFields: [], at` (tanpa nilai PII) | |

**Jenis ledger (string union divalidasi zod, bukan DB enum):** `RENTAL`, `ADD_ON`, `MEETUP_FEE`, `DISCOUNT`, `DEPOSIT_IN`, `DEPOSIT_REFUND`, `DEPOSIT_DEDUCTION`, `LATE_FEE`, `DAMAGE_CHARGE`, `CANCELLATION_FEE`, `REFUND`, `GATEWAY_FEE`.

- **Baki deposit** = Σ(`DEPOSIT_IN`, `DEPOSIT_REFUND`, `DEPOSIT_DEDUCTION`) bagi `bookingId` tersebut, dikira oleh Worker (query koleksi `ledgerEntries` where `bookingId ==`) sebelum membenarkan transition ke `completed`. **Firestore tiada aggregate constraint automatik** — ini mesti disemak secara eksplisit dalam kod transition.
- **Custom claim admin:** ditetapkan melalui Firebase Admin Auth REST API (`setCustomUserClaims` setara), disahkan di Worker dengan **mengesahkan ID token JWT** (tandatangan Google public key, boleh guna `jose` library — serasi Workers) dan semak `claims.admin === true`.
- **Storage:** folder `handover/{bookingId}/{checkout|return}/{uuid}.jpg`, ≤ 8 MB, `image/*`. Muat naik/turun **hanya** melalui Worker, yang menjana signed URL (Cloud Storage REST `v1/b/{bucket}/o?uploadType=resumable` dengan token service account) berumur pendek (contoh 15 minit).
- **ID awam:** `refCode` pendek, rawak, tanpa aksara mengelirukan (contoh `PK-7F3K9Q`) — Worker semak keunikan dengan query sebelum create. `lookupToken` = 32 byte rawak base64url; simpan SHA-256 hash sahaja dalam `lookupTokenHash`.

---

## 5. PERATURAN DOMAIN (NILAI AWAL DALAM `settings/*`)

*(Tiada perubahan daripada versi Supabase — peraturan bisnes tidak bergantung kepada pilihan database.)*

### Harga (sen)

| Tempoh | Harga |
|---|---|
| 1 hari | 6900 |
| 2 hari | 12000 |
| 3 hari | 17000 |
| 4 hari ke atas | 5000 × hari |

- **rentalDays** = `ceil((returnAt − pickupAt) / 24j)`, minimum 1.
- Tiada pakej hujung minggu.
- **Add-on lens filter:** CPL / VND 2-32, 500 setiap satu, maksimum mengikut bilangan yang dipilih. Magnetic Filter Base disertakan automatik & percuma apabila mana-mana lens dipilih (bukan item berasingan yang boleh dipilih sendiri).
- **Meetup:** mengikut `meetupLocations` dalam settings (nilai awal: Parit Buntar / Bandar Baharu / Nibong Tebal = 0).

### Slot serahan (MYT)

Diisi mengikut operasi sebenar semasa — lokasi: Parit Buntar, Bandar Baharu, Nibong Tebal. (Jadual slot tepat disahkan dengan saya semasa Fasa 0/1, bukan ditulis hard-code di sini.)

- `pickupAt` = permulaan slot pickup; `returnAt` = permulaan slot return; `returnSlotEnd` = penghujung slot return.
- **Julat hari yang dikunci** = setiap hari kalendar dari tarikh `pickupAt` hingga tarikh `returnSlotEnd` (inklusif), + `buffer`.
- `buffer` = 12 jam, atau 24 jam dalam `peakPeriods` (jika buffer melangkaui ke hari seterusnya, hari itu turut dikunci — lihat Seksyen 6).
- `minLeadHours` = 24.
- Blackout tarikh dibuat melalui dokumen `availabilityLocks` `kind='maintenance'`.

### Deposit

- Flat **RM100 (10000 sen)** untuk semua tempahan — bukan bertingkat mengikut tier.
- Tier pelanggan (`new`/`verified`/`returning`) kekal direkod untuk tujuan risiko & laporan, tetapi **tidak** menentukan amaun deposit pada MVP.
- Admin boleh set `verified` atau `blocked`.
- Pelanggan `blocked` → tempahan ditolak dengan mesej umum (jangan dedah sebab).

### Pembayaran MVP

- **Bayaran penuh semasa tempahan** = sewa + add-on lens filter (jika dipilih) + meetup + deposit RM100, dalam satu checkout CHIP dengan line item berasingan.
- Ledger yang ditulis semasa pengesahan: `RENTAL`, `ADD_ON`, `MEETUP_FEE`, `DEPOSIT_IN`.

### Pembatalan (dikira server-side, dipaparkan kepada pelanggan sebelum bayar)

| Masa sebelum pickup | Polisi |
|---|---|
| > 72 jam | Refund penuh, tolak yuran gateway sebenar |
| 24–72 jam | Satu kali tukar tarikh percuma, ATAU refund tolak RM30 (`CANCELLATION_FEE`) |
| < 24 jam / tidak hadir | RM30 dilucutkan; baki termasuk deposit dipulangkan |
| Dibatal oleh perniagaan | Refund 100% |

Refund dibuat manual oleh admin dan direkod dalam ledger (MVP).

### Lewat pulang

- Grace 30 minit selepas `returnSlotEnd`, kemudian status → `overdue` (Worker Cron Trigger).
- Caj: RM15 bagi setiap blok 6 jam yang dimulakan, dihadkan pada kadar 1 hari bagi setiap 24 jam.
- **Admin mesti meluluskan** caj sebelum direkod sebagai `LATE_FEE`.

---

## 6. KETERSEDIAAN & ANTI DOUBLE-BOOKING (KRITIKAL)

Ini ialah bahagian yang **paling berbeza** daripada reka bentuk Postgres asal. Firestore tiada exclusion constraint atau GiST — anti double-booking mesti dibina sepenuhnya melalui **corak dokumen-per-hari + transaction precondition**.

### Corak kunci: satu dokumen per unit per hari

- Koleksi `availabilityLocks`, **ID dokumen deterministik**: `{unitId}_{yyyy-MM-dd}` (contoh `unit01_2026-12-24`).
- Untuk mengunci julat tarikh (pickup hingga return+buffer), Worker mesti **mencuba create setiap dokumen hari** dalam julat tersebut, **satu transaction setiap dokumen**, dengan precondition `currentDocument.exists = false` pada REST `:commit`.
- Jika **mana-mana satu** hari dalam julat gagal (dokumen sudah wujud & `active=true`), Worker mesti **rollback** (padam semula semua dokumen hari yang berjaya dicipta sebelum kegagalan) dan pulangkan ralat `SLOT_UNAVAILABLE` (HTTP `409`).
- Ini **bukan transaksi tunggal merentasi berbilang hari** (Firestore transaction REST tidak membenarkan berbilang `create` dengan precondition berasingan dalam satu panggilan merentasi dokumen yang tidak diketahui lebih awal dengan mudah) — gunakan pendekatan **"cuba create berjujukan, rollback jika gagal"**, dan dokumenkan dengan jelas bahawa ini ialah **best-effort atomicity**, bukan atomicity penuh seperti Postgres. **WAJIB ada ujian concurrency (lihat Seksyen 12)** untuk mengesahkan tiada double-booking berlaku walaupun dengan pendekatan ini.
- Alternatif yang lebih selamat (disyorkan jika ujian concurrency menunjukkan race condition): guna **satu dokumen "ringkasan julat" per unit** (contoh `unitAvailability/{unitId}`) yang menyimpan array julat terkunci, dikemas kini melalui **Firestore transaction tunggal** (`runTransaction`: baca dokumen → semak overlap dalam kod (guna `packages/shared/overlap.ts`) → tulis semula array jika tiada overlap). Pendekatan ini memberi **atomicity sebenar** (satu dokumen, satu transaction) tetapi menghadkan concurrency kepada satu unit pada satu masa (boleh diterima kerana bilangan unit kecil). **Claude Code: nilai kedua-dua corak semasa Fasa 0, pilih satu berdasarkan keputusan ujian concurrency, dan catat sebab dalam `DECISIONS.md`.**

### Alur `createBookingHold(...)` (dalam kod Worker, bukan RPC database)

Worker melakukan langkah-langkah ini **sebelum** cuba kunci slot:
1. Sahkan Turnstile, rate limit dan zod.
2. Normalisasi telefon ke E.164 + kira `phoneHash`.
3. Baca `settings/*` + cari/cipta `customers` ikut `phoneHash` (query + create dalam transaction untuk elak duplicate).
4. Kira julat tarikh dan `priceBreakdown` (guna `packages/shared`; **abaikan harga daripada klien**).
5. Untuk unit `active` model berkenaan (ikut susunan tetap), cuba kunci julat tarikh (corak di atas). Berjaya → guna unit itu, teruskan ke langkah 6. Semua unit gagal → `SLOT_UNAVAILABLE` (`409`).
6. Create dokumen `bookings` (`status='pending_payment'`, `holdExpiresAt = now + holdMinutes`) + `bookingEvents`.
7. Pulangkan `bookingId, refCode`. Worker menjana `lookupToken`; Firestore hanya menyimpan hash-nya.

Selepas berjaya, Worker cipta checkout CHIP. Jika gagal → padam/nyahaktifkan semula dokumen `availabilityLocks` yang telah dicipta + batalkan booking (`cancelled`, reason `checkout_failed`).

### Peralihan kunci (dalam kod transition yang sama)

| Peralihan | Kesan pada `availabilityLocks` |
|---|---|
| `pending_payment → confirmed` | Tukar `kind` setiap dokumen hari daripada `hold` kepada `booking`, kosongkan `holdExpiresAt` |
| `cancelled` / `refund_pending` (sebelum pickup) / `refunded` | Padam atau tandakan `active=false` semua dokumen hari berkaitan `bookingId` |
| `completed` awal | Padam dokumen hari yang tidak lagi diperlukan (selepas tarikh pemulangan sebenar + buffer) |
| `overdue` | Dokumen hari kekal aktif. Worker Cron mengenal pasti tempahan seterusnya yang terjejas untuk amaran admin. |

### Kes tepi (WAJIB ada ujian)

- **Webhook bayar tiba selepas hold tamat:**
  - Worker cuba kunci semula hari-hari berkenaan.
  - Jika gagal (sudah diambil tempahan lain) → booking ke `refund_pending`, `statusReason='paid_after_hold_expired_conflict'`, dan outbox email segera kepada admin.
  - Jika masih bebas → kunci semula, `confirmed`.
- **Dua (atau 20) permintaan serentak untuk slot sama** → tepat satu berjaya. **Ini ialah ujian paling kritikal dalam seluruh sistem** kerana Firestore tiada constraint native seperti Postgres — jalankan ujian beban (load test) terhadap emulator sebelum yakin dengan corak yang dipilih.
- Dokumen `availabilityLocks` `kind='maintenance'` yang bertindih dengan tempahan aktif → Worker **mesti** menyemak dan menolak percubaan create maintenance jika hari tersebut sudah ada `kind='booking'` aktif.
- Unit `maintenance` / `retired` tidak pernah dipilih (ditapis di langkah 5 di atas).

### Jadual tugas (Cloudflare Workers Cron Triggers, semuanya memanggil Firestore REST API)

| Bila | Tugas |
|---|---|
| Setiap 1 min | Query `bookings` where `status='pending_payment' and holdExpiresAt <= now()`; batalkan + lepaskan kunci |
| Setiap 5 min | Query tempahan `active_rental` lepas `returnSlotEnd + grace`; tandakan `overdue` + outbox amaran admin |
| Setiap 1 min | Proses `notificationsOutbox` (retry dengan backoff; `failed` selepas 5 cubaan) |
| Harian 03:00 MYT | Padam dokumen `availabilityLocks` tidak aktif > 30 hari + retention (Fasa 3) |
| Harian 08:00 MYT | Email ringkasan admin: pickup & pemulangan hari ini, overdue, deposit belum dipulangkan > 24 jam, `refund_pending` |
| Harian 18:00 MYT | Enqueue peringatan H-1 pickup & hari pemulangan |

> Nota: Cloudflare Cron Triggers menggunakan UTC — tukar masa dengan betul ke `Asia/Kuala_Lumpur`.

---

## 7. STATE MACHINE TEMPAHAN

Dikuatkuasakan **sepenuhnya dalam kod Worker** (bukan di Firestore — tiada trigger/constraint database di sini):

1. `packages/shared/stateMachine.ts` — pure function `canTransition(from, to, actorType): boolean`, dikongsi UI dan Worker.
2. Setiap endpoint Worker yang mengubah status **mesti**: baca dokumen semasa dalam transaction → panggil `canTransition` → jika tidak sah, tolak dengan ralat jelas tanpa menulis apa-apa → jika sah, tulis status baharu + `bookingEvents` + `auditLogs` dalam transaction yang sama.
3. Admin menukar status **hanya** melalui endpoint `POST /api/admin/bookings/:id/transition`, yang mengesahkan ID token (custom claim `admin`) dan menjalankan semakan di atas.

| Dari | Ke | Actor | Syarat |
|---|---|---|---|
| `pending_payment` | `confirmed` | webhook | Bayaran disahkan & amaun tepat |
| `pending_payment` | `cancelled` | system/admin | Hold tamat / dibatal |
| `pending_payment` | `refund_pending` | webhook | Dibayar selepas konflik slot |
| `confirmed` | `ready_for_pickup` | admin | Checklist pra-serahan lulus |
| `confirmed` | `refund_pending` | admin | Pembatalan berbayar |
| `ready_for_pickup` | `active_rental` | admin | Serahan direkod: idLast4, foto, checklist, aksesori |
| `ready_for_pickup` | `refund_pending` | admin | Batal / tidak hadir |
| `active_rental` | `return_inspection` | admin | Unit diterima |
| `active_rental` | `overdue` | system | Lepas grace |
| `overdue` | `return_inspection` | admin | Unit diterima |
| `overdue` | `disputed` | admin | Tidak dipulangkan / isu |
| `return_inspection` | `completed` | admin | Pemeriksaan lulus **&** baki deposit (dikira oleh query, lihat Seksyen 4) = 0 |
| `return_inspection` | `disputed` | admin | Kerosakan / aksesori hilang |
| `disputed` | `completed` | admin | Diselesaikan & baki deposit = 0 |
| `refund_pending` | `refunded` | admin | Refund direkod dalam ledger |

Status terminal: `completed`, `refunded`, `cancelled`.

**Ujian wajib (Seksyen 12):** setiap peralihan sah & tidak sah mesti diuji di peringkat `packages/shared` **dan** di peringkat integrasi Worker (pastikan endpoint benar-benar menolak peralihan tidak sah, bukan hanya pure function sahaja).

---

## 8. KESELAMATAN & PRIVASI

**Akses data**
- **Tiada client (termasuk admin frontend) menulis terus ke Firestore.** Semua tulisan melalui Worker API.
- Bacaan admin frontend (jika guna client SDK terus): Firestore Security Rules `allow read: if request.auth.token.admin == true;` pada koleksi yang dibenarkan, `allow write: if false;` global.
- Worker mengesahkan setiap permintaan admin dengan mengesahkan **ID token JWT Firebase** (tandatangan RS256 disahkan guna public key Google JWKS — library `jose`, serasi Workers) dan semak `claims.admin === true`.
- Firestore Security Rules (`firebase/firestore.rules`) dan Storage Rules (`firebase/storage.rules`) diuji dengan `@firebase/rules-unit-testing` pada setiap fasa.

**Akaun admin**
- Signup awam dimatikan (tiada UI/endpoint signup didedahkan; akaun dicipta terus melalui Firebase Console atau `scripts/grant-admin.ts`).
- Admin ditambah melalui `scripts/grant-admin.ts` sahaja (set custom claim `admin: true` melalui Admin Auth REST API).
- **MFA:** Firebase Authentication asas (email/password) **tidak menyokong TOTP MFA** tanpa naik taraf ke **Identity Platform** (kos tambahan per MAU). Pilihan:
  - (a) Naik taraf ke Identity Platform untuk MFA TOTP sebenar — **dapatkan kelulusan kos saya dahulu**; atau
  - (b) MVP tanpa MFA, tetapi perkuatkan dengan: kata laluan kukuh wajib, had percubaan log masuk (rate limit di Worker), log masuk dari IP luar biasa dimaklumkan ke email admin, sesi tamat pendek.
  - **Claude Code: cadangkan (a) jika kos munasabah, (b) sebagai fallback sementara.** Catat keputusan dalam `DECISIONS.md`.

**Endpoint awam (Worker)**
- Turnstile + rate limit (IP + `phoneHash`; contoh maks 5 hold / 10 min, 10 lead / jam).
- zod pada semua input.
- Respons ralat generik, tanpa stack trace.
- Bandingan token menggunakan constant-time.

**Output & header**
- **Jangan guna `innerHTML` dengan data pengguna.** Guna `textContent` atau template selamat.
- Header keselamatan dari Worker: CSP ketat (benarkan domain Turnstile, Firebase, CHIP sahaja), HSTS, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `frame-ancestors 'none'`.

**Log**
- Logger berstruktur dengan redaksi: tiada nama, telefon, email, `idLast4` atau token.
- Guna `bookingId` / `refCode` sahaja.

**Privasi (PDPA)**
- Tiada salinan MyKad dalam sistem digital ini.
- Persetujuan direkod bersama versi T&C/privasi + masa.
- Foto serahan dipadam 30 hari selepas baki deposit = 0 tanpa pertikaian (tempoh dalam `settings`) — dilaksanakan sebagai Worker Cron yang memadam objek Cloud Storage + field berkaitan.
- Tempoh simpanan data pelanggan dalam `settings` — tandakan **"perlu sahkan dengan akauntan"** untuk rekod kewangan.

**Rahsia**
- Disimpan dalam Worker secrets / GitHub Secrets sahaja (termasuk Firebase service account JSON lengkap — **jangan** letak dalam repo).
- Secret scanning dalam CI.

---

## 9. PEMBAYARAN — CHIP (MELALUI ADAPTER)

*(Tiada perubahan konseptual daripada versi Supabase — hanya lapisan penulisan data bertukar kepada Firestore REST.)*

```ts
interface PaymentProvider {
  createCheckout(input: { booking; lineItems; successUrl; failureUrl; callbackUrl }): Promise<{ providerRef: string; checkoutUrl: string }>;
  verifyAndParseWebhook(req: Request): Promise<VerifiedPaymentEvent>; // throw jika tandatangan tidak sah
  fetchPayment(providerRef: string): Promise<ProviderPaymentStatus>;
}
```

- **Baca dokumentasi rasmi CHIP terkini** (Purchases/Collect API, callback, kaedah pengesahan tandatangan, sandbox). Catat dalam `docs/PAYMENT_AND_DEPOSIT_SPEC.md`. Jangan andaikan format.

**Aliran webhook di Worker:**
1. Sahkan tandatangan.
2. **Re-fetch status bayaran dari API CHIP.**
3. Semak `paidSen == expectedSen` dan mata wang MYR.
4. Cuba `create` dokumen `webhookEvents/{provider}_{eventKey}` dengan precondition `exists=false`. Gagal (sudah wujud) → pulangkan `already_processed`, HTTP 200.
5. Dalam Firestore transaction: kemas kini `payments` + `bookings`, tulis `ledgerEntries` (create sahaja), kunci/kemas kini `availabilityLocks`, enqueue `notificationsOutbox`.
6. Pulangkan 200.

**Prinsip lain:**
- Halaman "berjaya" di browser **tidak pernah** mengesahkan tempahan; ia hanya poll endpoint lookup.
- Tiada data kad disimpan. Staging guna mod sandbox.
- Refund/deposit (MVP): admin buat refund manual (DuitNow / dashboard CHIP) → endpoint `admin_record_ledger_entry` dengan `reference`. Integrasi refund API ditangguh sehingga disahkan.

---

## 10. API

### Awam (Worker, `/api/*`)

| Endpoint | Fungsi |
|---|---|
| `GET /api/availability?from=&to=` | Senarai hari sibuk per unit (query `availabilityLocks`, tanpa PII) + slot & lokasi aktif |
| `POST /api/leads` | Fasa 1. Turnstile + rate limit |
| `POST /api/quote` | Harga + deposit (tier mengikut telefon jika wujud, jika tidak `new`) |
| `POST /api/bookings/hold` | Seksyen 6. Pulang `{ refCode, lookupToken, checkoutUrl, holdExpiresAt }` |
| `POST /api/webhooks/chip` | Seksyen 9 |
| `GET /api/bookings/lookup?ref=&token=` | Paparan terhad: status, tarikh, slot, lokasi, ringkasan bayaran, resit |

### Admin (`/api/admin/*`, semua mengesahkan ID token + custom claim `admin`)

- `POST /api/admin/bookings/:id/transition`
- `POST /api/admin/bookings/:id/handover`
- `POST /api/admin/bookings/:id/return-inspection`
- `POST /api/admin/ledger-entries`
- `POST /api/admin/deposit-refunds`
- `POST /api/admin/late-fees/:id/approve`
- `POST /api/admin/blocks` (maintenance)
- `DELETE /api/admin/blocks/:id`
- `PUT /api/admin/units/:id`
- `PUT /api/admin/customers/:id`
- `PUT /api/admin/settings/:key`
- `PUT /api/admin/leads/:id`
- Bacaan: boleh terus guna Firebase client SDK + Security Rules, **atau** melalui `GET /api/admin/*` setara jika mahu satu lapisan konsisten (Worker). **Pilih satu pendekatan secara konsisten — jangan campur.**

Dokumentasikan semua dalam `docs/API_SPECIFICATION.md` (request, response, kod ralat).

---

## 11. UI/UX

*(Tiada perubahan daripada versi Supabase — UI tidak bergantung kepada pilihan backend.)*

### Awam (BM, mobile-first, WCAG AA, pantas pada 4G)

**`/` — landing page**, susunan seksyen:
1. Hero + CTA "Semak tarikh"
2. Video demo
3. Spesifikasi sahih Pocket 4P
4. Senarai kit bergambar
5. Harga + kalkulator (deposit dipaparkan **berasingan**)
6. Cara tempah (4 langkah) + slot & lokasi
7. Polisi ringkas
8. Ulasan sebenar (kosong sehingga ada — **jangan cipta testimoni**)
9. FAQ
10. Maklumat perniagaan (CPETTR: nama, SSM, alamat, telefon, email)

**`/tempah` — wizard tempahan:**
1. Tarikh (tarikh penuh dikelabukan)
2. Slot & lokasi
3. Add-on lens filter (CPL/VND)
4. Maklumat pelanggan
5. Semakan harga penuh + checkbox T&C & privasi
6. Bayar

Papar kiraan detik hold. Jika `409` → mesej mesra + cadangan tarikh terdekat yang bebas.

**Halaman lain:**
- `/tempahan?ref=&token=` — status, butiran, resit, butang WhatsApp sokongan, panduan pemulangan.
- `/terma`, `/privasi`, `/polisi`, `/panduan`, `/soalan-lazim`.
- Semua rentetan UI dalam `strings.bm.ts` (sedia untuk i18n; BM sahaja untuk MVP).

### Admin (`/admin`)

- **Hari Ini:** pickup, pemulangan, overdue, deposit belum dipulangkan, `refund_pending`. Setiap item ada butang tindakan + butang **WhatsApp** (`wa.me` dengan templat pra-isi).
- **Kalendar:** paparan bulan/minggu ikut unit; warna berbeza untuk booking / hold / maintenance / buffer.
- **Tempahan:** senarai + filter. Halaman detail: timeline events, butang transition (yang sah sahaja), borang checklist serahan/pemulangan, upload foto, ledger + baki deposit, nota.
- **Unit, Pelanggan, Leads, Settings** (borang tervalidasi), **Audit log**.
- **Laporan** (Fasa 3).

### Email (BM, melalui outbox)

- **Pelanggan:** pengesahan + resit bernombor; peringatan H-1 pickup; peringatan hari pemulangan; deposit dipulangkan + jemputan ulasan.
- **Admin:** tempahan baharu, konflik bayaran, overdue, ringkasan harian.
- Kegagalan email **tidak pernah** menjejaskan rekod tempahan.

---

## 12. UJIAN & KRITERIA PENERIMAAN

### Unit (`packages/shared`)
- Pricing: setiap tempoh, had add-on, meetup.
- `rentalDays`, buffer/peak.
- Overlap (sempadan tarikh, inklusif/eksklusif).
- State machine: semua peralihan sah & tidak sah.
- Money (tiada float).

### Emulator Firebase + Security Rules (gantian pgTAP) — semua MESTI lulus
- [ ] Security Rules tolak **semua** tulisan client ke setiap koleksi.
- [ ] Security Rules benarkan bacaan admin (`claims.admin==true`) sahaja; client tanpa claim/log masuk ditolak.
- [ ] Corak kunci `availabilityLocks` (atau `unitAvailability`, bergantung pilihan Fasa 0): dua percubaan create serentak untuk hari/unit sama → tepat satu berjaya.
- [ ] `webhookEvents` create dengan `eventKey` sama 2× → kedua idempotent (hanya satu kesan).
- [ ] `ledgerEntries`: Security Rules tolak update/delete; Worker tidak pernah memanggilnya.
- [ ] `receiptCounters` transaction: 10 panggilan serentak → 10 nombor unik berjujukan, tiada pertindihan.

### Integrasi (Worker + Firebase Emulator Suite)
- [ ] Aliran biasa: hold → webhook sah → `confirmed`, ledger betul, outbox email wujud.
- [ ] **20 permintaan `hold` serentak untuk slot sama → tepat 1 berjaya, 19 dapat `409`.** (Ujian paling kritikal — jalankan berulang kali, bukan sekali sahaja, untuk mengesan race condition jarang berlaku.)
- [ ] Tandatangan webhook tidak sah / bayaran gagal → tiada `confirmed`.
- [ ] Amaun dibayar ≠ jangkaan → tidak disahkan, admin dimaklumkan.
- [ ] Hold tamat → `cancelled`, slot boleh ditempah semula (kunci dilepaskan dengan betul).
- [ ] Bayar selepas hold tamat: slot bebas → `confirmed`; slot diambil → `refund_pending`.
- [ ] `overdue` ditanda selepas grace; tempahan seterusnya yang terjejas dilaporkan.
- [ ] Blok maintenance menghalang tempahan baharu pada hari yang sama.
- [ ] Lookup dengan token salah → 404 generik.
- [ ] Rate limit & Turnstile berfungsi.
- [ ] Log bebas PII (snapshot test logger).
- [ ] Transition tidak sah (contoh `pending_payment → completed` terus) ditolak oleh endpoint, bukan hanya oleh pure function.

### Manual / E2E
- Aliran penuh pada iOS Safari & Android Chrome.
- Checkout CHIP sandbox.
- Lighthouse mobile ≥ 90 (Performance, Accessibility, Best Practices).

### Launch checklist (sebelum production)
- [ ] Semua ujian lulus, termasuk ujian concurrency berulang (bukan sekali).
- [ ] Firestore Security Rules + Storage Rules diuji & dikaji semula.
- [ ] Rahsia prod diset (termasuk Firebase service account production berasingan daripada staging).
- [ ] Domain + HTTPS.
- [ ] CSP lulus.
- [ ] Keputusan MFA admin (Identity Platform atau mitigasi alternatif) dibuat & dilaksana.
- [ ] Keputusan pelan Firebase prod dibuat (Spark/Blaze, kuota, kos).
- [ ] Backup harian (export Firestore) berjalan + **restore diuji ke staging**.
- [ ] T&C/privasi/polisi v1 diterbitkan.
- [ ] `RUNBOOK_MANUAL_FALLBACK.md` siap (WhatsApp + kalendar jika sistem down).

---

## 13. DEPLOYMENT & BACKUP

- **CI (GitHub Actions):** typecheck → lint → unit → `firebase emulators:exec` (jalankan ujian integrasi + rules terhadap emulator) → build Worker.
- **Deploy:**
  - Firestore rules & indexes: `firebase deploy --only firestore:rules,firestore:indexes,storage:rules` (staging dahulu, kemudian production).
  - Worker: `wrangler deploy --env staging|production` (dari CI, atau manual dengan arahan jelas).
- **Backup (Firestore managed export):**
  - GitHub Actions harian: panggil **Firestore Export REST API** (`projects.databases.exportDocuments`, memerlukan pelan Blaze + bucket Cloud Storage destinasi) melalui service account.
  - Simpan export dalam Cloud Storage bucket berasingan (lifecycle 30 hari), **atau** salin ke **Cloudflare R2** selepas export jika mahu backup luar ekosistem Google sepenuhnya.
  - Runbook restore (`projects.databases.importDocuments`) dalam `docs/DEPLOYMENT_AND_BACKUP.md` **diuji sekali sebelum launch**.
- **Pemantauan:**
  - Worker logs/observability + alert untuk ralat 5xx & kegagalan webhook.
  - Outbox `failed` → muncul dalam ringkasan harian.
  - Uptime check laman awam.

---

## 14. DOKUMENTASI (`docs/`)

Fail wajib:
- `ARCHITECTURE.md`
- `DECISIONS.md` (ADR ringkas — **wajib catat keputusan Firebase Admin SDK vs REST, corak kunci availability, dan keputusan MFA**)
- `BOOKING_AND_INVENTORY_LOGIC.md`
- `DATABASE_SCHEMA.md` (struktur koleksi Firestore, bukan jadual SQL)
- `API_SPECIFICATION.md`
- `PAYMENT_AND_DEPOSIT_SPEC.md`
- `SECURITY_AND_PRIVACY.md` (**jelaskan model "Worker ialah satu-satunya lapisan penguatkuasaan"**)
- `TESTING_AND_ACCEPTANCE_CRITERIA.md`
- `DEPLOYMENT_AND_BACKUP.md`
- `RUNBOOK_MANUAL_FALLBACK.md`
- `README.md` (setup lokal < 10 langkah)

Semua dokumen mesti konsisten dengan kod dan dikemas kini setiap fasa.

---

## 15. DEFINITION OF DONE (SETIAP FASA)

- TS strict; tiada `any` tanpa justifikasi; lint bersih.
- Semua ujian fasa lulus dalam CI (termasuk ujian emulator & concurrency).
- Tiada rahsia dalam repo atau bundle frontend.
- Docs + `CLAUDE.md` dikemas kini.
- Ringkasan kepada saya:
  - apa yang siap
  - keputusan + sebab (khususnya sebarang keputusan dalam Seksyen 2/6/8 yang masih "sahkan dahulu")
  - risiko terbuka
  - langkah ujian manual
  - apa yang perlu saya sediakan (akaun, key, domain)

---

## 16. PERKARA YANG SAYA SEDIAKAN / SAHKAN (TANYA HANYA BILA MENYEKAT)

1. Domain (`{{DOMAIN}}`).
2. Akaun Firebase (projek staging & production) + pelan (Spark/Blaze) — keputusan selepas Claude Code anggarkan kos.
3. Akaun Cloudflare (Workers, Turnstile, R2).
4. Akaun CHIP (sandbox & live) — akaun berasingan atau berkongsi dengan bisnes lain.
5. Domain penghantar email + API key.
6. Email admin.
7. Nombor WhatsApp Business (017-491 3169).
8. Maklumat perniagaan untuk footer (SSM, alamat, telefon).
9. Versi akhir T&C, privasi & polisi. Draf awal boleh dijana sebagai placeholder bertanda **"DRAF — BELUM DISEMAK PEGUAM"**.
10. Keputusan MFA admin: naik taraf Identity Platform (ada kos) atau mitigasi alternatif (Seksyen 8).

**Mula sekarang: masuk plan mode, baca dokumen ini, selesaikan dahulu percubaan keserasian Firebase Admin SDK/REST di Workers (Seksyen 2), kemudian bentangkan pelan Fasa 0.**
