# Ujian & Kriteria Penerimaan

**Status Fasa 1:** 1,112 ujian, semuanya lulus (ditambah satu semakan E2E Playwright manual, lihat bawah).

| Suite              | Di mana ia berjalan                 | Ujian | Arahan               |
| ------------------ | ----------------------------------- | ----- | -------------------- |
| Logik domain       | Node                                | 621   | `pnpm test:unit`     |
| Unit Worker        | workerd                             | 154   | `pnpm test:unit`     |
| Integrasi Worker   | workerd + Firestore & Auth emulator | 69    | `pnpm test:emulator` |
| Security Rules     | Node + Firestore & Storage emulator | 255   | `pnpm test:emulator` |
| Laman web (render) | Node                                | 10    | `pnpm test:unit`     |
| `grant-admin`      | Node + Auth & Firestore emulator    | 3     | `pnpm test:emulator` |

Ujian Worker berjalan dalam **workerd**, runtime yang sama dengan production, melalui
`@cloudflare/vitest-plugin`. `pnpm test:emulator` menghidupkan dan mematikan emulator
sendiri (perlu Java).

## Cara menjalankan

```sh
pnpm typecheck        # TS strict, semua pakej
pnpm lint             # ESLint + semakan format Prettier
pnpm test:unit        # logik domain (dengan gate coverage) + unit Worker
pnpm test:emulator    # rules + integrasi Worker terhadap emulator
pnpm test             # kedua-duanya
pnpm build            # build Vite + wrangler deploy --dry-run
```

CI (`.github/workflows/ci.yml`) menjalankan kesemuanya pada setiap push, serta imbasan
rahsia gitleaks.

## Liputan

`packages/shared` mempunyai gate **90%** (baris, cabang, fungsi, pernyataan) dalam
`vitest.config.ts`; build gagal di bawahnya. Semasa: **100%** pada keempat-empatnya.

## Apa yang dibuktikan

### Unit — `packages/shared`

| Bidang        | Liputan                                                                                       |
| ------------- | --------------------------------------------------------------------------------------------- |
| Wang          | Integer sahaja; float, `NaN`, integer tidak selamat ditolak; format RM                        |
| Masa          | Hari MYT lwn UTC; disemak silang dengan `Intl` untuk 2,600 instant; tahun lompat              |
| Tempoh        | `rentalDays` pada setiap sempadan; buffer biasa/peak; buffer tamat tepat tengah malam         |
| Harga         | Setiap tempoh 1–7 hari; had add-on; add-on tidak aktif/pendua; yuran meetup; diskaun; deposit |
| Pertindihan   | Sempadan inklusif (hari) dan eksklusif (selang masa)                                          |
| State machine | **Semua 363 gabungan** status × status × actor lwn jadual bebas; terminal; kebolehcapaian     |
| Ledger        | Baki deposit termasuk potongan dan reversal                                                   |
| Caj lewat     | Grace, setiap sempadan blok, had 24 jam                                                       |
| Pembatalan    | Setiap tier dan sempadan 72 j / 24 j; refund tidak pernah negatif                             |
| Skema         | Setiap `settings/*` lalai sah; 29 kes tidak sah ditolak                                       |

### Unit — Worker

| Bidang          | Liputan                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Auth Google     | JWT RS256 disahkan dengan kunci awam; cache dan refresh token; kunci bukan PKCS#8 ditolak; ralat tidak membocorkan rahsia |
| Codec nilai     | Pergi-balik semua jenis; float ditolak; transform; nama medan terpelihara                                                 |
| Klien Firestore | Bentuk permintaan REST; pemetaan ralat; timeout; laluan tidak sah                                                         |
| Logger          | **Snapshot bebas PII**; ralat dan punca diredaksi; stack hanya di dev                                                     |
| Konfigurasi     | Hos emulator ditolak di staging/production; hos bukan loopback ditolak                                                    |
| HTTP            | `/api/health`; 404/405/500 generik; header keselamatan                                                                    |

### Emulator — integrasi Worker

- CRUD, precondition (`exists`, `updateTime`), increment, query, transaction.
- **Commit atomik:** satu precondition gagal → tiada write diterapkan.
- **Idempotency webhook:** ID sama 2× → satu kesan; 10 serentak → tepat 1 berjaya.
- **Kaunter resit:** 10 transaction serentak → nombor 1–10, unik dan berjujukan.
- **Kunci slot:** lihat di bawah.

### Emulator — Security Rules

Tiga jenis pemanggil (pelawat, pengguna log masuk, **admin log masuk**) × 14 koleksi ×
baca / senarai / cipta / kemas kini / padam, serta koleksi bersarang dan Storage
(muat turun, senarai, muat naik, padam). Semuanya mesti ditolak.

Ujian ini disemak dengan mutasi: apabila rules diubah untuk membenarkan bacaan admin,
tepat 29 ujian gagal — jadi ujian benar-benar mengesan `allow` yang tersilap.

## Ujian paling kritikal: perlumbaan kunci slot

`apps/worker/test/integration/availabilityLocks.test.ts`

Setiap pusingan melancarkan **20 permintaan serentak** ke atas satu unit. Julat tarikh
mereka berperingkat tetapi semuanya berkongsi sekurang-kurangnya satu hari, dan setiap
permintaan turut mencipta dokumen `bookings` sendiri. Selepas setiap pusingan:

1. tepat **satu** permintaan berjaya;
2. hanya hari milik pemenang yang dikunci — tiada kunci yatim;
3. hanya dokumen booking pemenang yang wujud;
4. setiap yang kalah diberitahu hari mana yang bertembung, dan hari itu memang milik
   pemenang.

**50 pusingan** setiap kali suite dijalankan (1,000 permintaan), pada setiap CI. Semasa
pembangunan suite ini lulus 9 larian penuh berturut-turut (450 pusingan), selain
percubaan awal 25 pusingan sebelum kod ditulis.

Untuk ujian rendaman yang lebih panjang, naikkan `ROUNDS` dalam fail ujian itu.

## Kriteria penerimaan master prompt §12

### Emulator + Security Rules

| Kriteria                                                          | Status                                                         |
| ----------------------------------------------------------------- | -------------------------------------------------------------- |
| Rules tolak semua tulisan client ke setiap koleksi                | ✅                                                             |
| Rules benarkan bacaan admin sahaja                                | ↪️ Diganti: admin pun ditolak; bacaan melalui Worker (ADR-003) |
| Dua create serentak untuk hari/unit sama → tepat satu berjaya     | ✅ (20 serentak × 50 pusingan)                                 |
| `webhookEvents` `eventKey` sama 2× → idempotent                   | ✅                                                             |
| `ledgerEntries`: update/delete ditolak; Worker tidak memanggilnya | ✅ rules · 📌 kod Fasa 2                                       |
| `receiptCounters`: 10 serentak → 10 nombor unik berjujukan        | ✅                                                             |

### Integrasi Worker

| Kriteria                                                           | Status                                                            |
| ------------------------------------------------------------------ | ----------------------------------------------------------------- |
| Log bebas PII (snapshot logger)                                    | ✅                                                                |
| Hold tamat → slot boleh ditempah semula                            | ✅ primitif kunci · 📌 aliran Fasa 2                              |
| Blok maintenance menghalang tempahan pada hari sama                | ✅ primitif kunci · 📌 endpoint Fasa 2                            |
| 20 `hold` serentak → tepat 1 berjaya, 19 dapat `409`               | ✅ primitif kunci · 📌 endpoint Fasa 2                            |
| Aliran hold → webhook → `confirmed`; ledger; outbox                | 📌 Fasa 2                                                         |
| Tandatangan webhook tidak sah / amaun tidak padan                  | 📌 Fasa 2                                                         |
| Bayar selepas hold tamat (bebas → sah; diambil → `refund_pending`) | 📌 Fasa 2                                                         |
| `overdue` selepas grace                                            | ✅ logik · 📌 cron Fasa 2                                         |
| Lookup token salah → 404 generik                                   | 📌 Fasa 2                                                         |
| Rate limit & Turnstile                                             | ✅ (Turnstile disimulasi; siteverify sebenar disahkan di staging) |
| Peralihan tidak sah ditolak oleh endpoint                          | ✅ logik · 📌 endpoint Fasa 2                                     |

### Manual / E2E dan launch checklist

Belum terpakai pada Fasa 0. Lihat master prompt §12.

## Fasa 1: apa yang dibuktikan

**Integrasi (emulator Firestore + Auth, dalam workerd):**

- `POST /api/leads`: lead disimpan dinormalkan tanpa IP mentah; ralat per medan dalam BM
  tanpa memantulkan input; tarikh lalu / > 1 tahun ditolak; Turnstile gagal → tiada tulisan;
  had 3/hari per telefon dan 10/jam per IP; **6 penyerahan serentak untuk had 3 → tepat 3
  lulus**; burst limiter.
- Admin: log masuk betul → cookie HttpOnly/Strict, hanya hash token disimpan, log masuk
  diaudit; kata laluan salah / akaun tiada / bukan admin / badan rosak → jawapan sama;
  Origin lain → 403; had 5 cubaan per emel (kata laluan betul pun ditolak dalam tetingkap);
  log keluar membatalkan cookie; cookie palsu ditolak; sesi tamat mutlak (8 j) dan tidak
  aktif (60 min); aktiviti melanjutkan sesi.
- Leads: tapis hari/status, susunan terbaharu dahulu, halaman berturutan tanpa ulangan;
  penapis tidak sah → 400; kemas kini status/nota + audit (nama medan sahaja); kemas kini
  tidak sah / ID tiada / Origin lain ditolak tanpa mengubah data; eksport CSV menapis dan
  meneutralkan formula.
- `grant-admin`: claim muncul dalam ID token seterusnya; `--revoke` memadam claim dan sesi
  akaun itu sahaja; emel tiada → ralat jelas.

**Unit:** penormalan telefon Malaysia; skema lead; HMAC; bacaan badan JSON (jenis, saiz);
cookie; Origin; CSV; Turnstile (strict / tidak strict / gagal); pengesahan ID token dengan
kunci RSA tempatan (tandatangan salah, tanpa tandatangan, audience/issuer/expiry, tiada
claim admin); pemetaan ralat Identity Toolkit; escaping templat HTML; dokumen staging lwn
production (noindex, canonical, banner draf).

**Rules:** 255 ujian, kini termasuk `adminSessions` dan `rateLimits`.

**E2E (Playwright, manual, bukan dalam CI):** `wrangler dev` + emulator, iPhone 13 dan
Pixel 7 — 23 semakan lulus: tiada skrol mendatar, kalkulator (3 hari + CPL = RM275),
ralat medan dan mesej berjaya borang (API & Turnstile disimulasi), semua halaman polisi,
404, tiada ralat konsol; admin: kata laluan salah ditolak, cookie HttpOnly/Strict, senarai
terbaharu dahulu, pautan WhatsApp pra-isi, tukar status, nota, tapis, eksport CSV, log
keluar.

**Lighthouse mobile (build tempatan):** landing — Performance 100, Accessibility 100, Best
Practices 100, SEO 63 (hanya `is-crawlable`: staging sengaja `noindex`). Admin — 100 / 100 /
96 (ralat konsol: `401` yang dijangka sebelum log masuk).

## Ujian manual Fasa 0

```sh
pnpm install
pnpm test                       # semua ujian

pnpm dev:emulators              # terminal 1
cp apps/worker/.dev.vars.example apps/worker/.dev.vars
pnpm dev                        # terminal 2

curl -i http://localhost:8787/api/health     # 200, JSON, header keselamatan
curl -i http://localhost:8787/               # halaman placeholder + CSP
curl -i http://localhost:8787/tiada          # 404 dengan halaman 404
curl -i -X POST http://localhost:8787/api/health   # 405, Allow: GET
```

## Had yang diketahui

- Emulator tidak menguatkuasakan composite index Firestore.
- Emulator menunggu 2 saat apabila commit bertembung pada dokumen yang sama; production
  berkelakuan berbeza dari segi masa, bukan ketepatan.
- Pertukaran token OAuth sebenar dengan Google tidak diuji tanpa service account sebenar.
