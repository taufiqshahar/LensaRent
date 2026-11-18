# Spesifikasi bayaran & deposit

Status: **Fasa 2, dibina dan diuji; belum dideploy.** Kod: `apps/worker/src/lib/chip.ts`,
`lib/holds.ts`, `lib/settlement.ts`, `routes/webhooks.ts`, `routes/adminBookings.ts`,
`scheduled.ts`. Keputusan: ADR-021 hingga ADR-023 dalam `DECISIONS.md`.

## 1. Gerbang bayaran: CHIP Collect

Disahkan daripada dokumentasi rasmi dan spesifikasi OpenAPI di `docs.chip-in.asia`
(dibaca 18 Nov 2026). Jika CHIP mengubah API, semak semula bahagian ini dahulu.

| Perkara              | Nilai yang digunakan                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| API                  | `https://gate.chip-in.asia/api/v1`                                                             |
| Pengesahan           | `Authorization: Bearer <CHIP_SECRET_KEY>` (Worker secret)                                      |
| Mod ujian            | Ditentukan oleh **kunci** (kunci ujian ⇒ `is_test: true`). Production menolak `is_test`.       |
| Cipta pembelian      | `POST /purchases/` — `brand_id`, `client{email,full_name,phone}`, `purchase{products,…}`       |
| Amaun                | Integer **sen**; satu produk bagi setiap baris (sewa, tambahan, caj lokasi, deposit)           |
| Had masa             | `due` = tamat tahanan (unix), `purchase.due_strict: true` ⇒ tidak boleh dibayar selepas itu    |
| Callback             | `success_callback` = `<origin>/api/webhooks/chip`                                              |
| Tandatangan callback | `X-Signature`: base64 RSA PKCS#1 v1.5 atas SHA-256 badan **mentah**                            |
| Kunci awam           | `GET /public_key/` (rentetan JSON berisi PEM), atau dipin melalui `CHIP_PUBLIC_KEY`            |
| Penghantaran         | Sekurang-kurangnya sekali, hingga 8 cubaan dalam ~36 jam ⇒ idempotensi wajib                   |
| Baca semula          | `GET /purchases/{id}/`                                                                         |
| Batal (jadikan mati) | `POST /purchases/{id}/cancel/` — 4xx bermakna tidak boleh dibatalkan lagi (cth. sudah dibayar) |

Konfigurasi Worker: `CHIP_SECRET_KEY` (secret), `CHIP_BRAND_ID`, pilihan `CHIP_PUBLIC_KEY`.
Tanpa kunci dan brand, tempahan dalam talian **ditutup** (`BOOKING_CLOSED`), laman dan
borang minat masih berfungsi.

## 2. Aliran tempahan

```
Pelanggan            Worker                                   CHIP
   │  POST /api/bookings/hold                                   │
   │──────────────────▶ semak (zod, peraturan, Turnstile, had)  │
   │                    SATU batch: kunci hari + tempahan + event
   │                    POST /purchases/ (due = tamat tahanan) ─▶│
   │◀── checkoutUrl ─── simpan payments(status=created)         │
   │──────────── bayar di halaman CHIP ────────────────────────▶│
   │                    ◀──── POST /api/webhooks/chip (bertandatangan)
   │                    sahkan tandatangan → GET /purchases/{id}/ ─▶│
   │                    SATU batch berpengawal: confirmed, kunci→booking,
   │                    payments=paid, lejar, no. resit, emel dalam outbox
```

- **Harga sentiasa dari server** (`planBooking` dalam `packages/shared`): quote dan hold
  memanggil fungsi yang sama, jadi tidak boleh berbeza. Klien tidak menghantar harga.
- Jika `POST /purchases/` atau rekod `payments` gagal: pembelian (jika ada) dibatalkan dahulu,
  kemudian tahanan dibatalkan dan hari dilepaskan serta-merta (`checkout_failed`).
- **Callback tidak dipercayai untuk hasil.** Selepas tandatangan sah, pembelian dibaca semula
  daripada API CHIP; hasil ditentukan oleh jawapan itu.
- Semakan sebelum disahkan: `status = paid`, mata wang `MYR`, `reference` = kod tempahan,
  amaun dibayar = `expected_sen` = `total_payable_sen`, dan mod ujian sepadan.
  Tidak sepadan ⇒ `refund_pending` (sebab `payment_<masalah>`), hari dilepaskan, admin
  dimaklumkan melalui emel, `refund_due_sen` = amaun yang diterima.

### Tahanan yang tamat (cron setiap minit)

Urutan ini memastikan tempahan yang sudah dibayar tidak pernah kehilangan tarikhnya:

1. Tunggu 2 minit selepas `hold_expires_at` (perbezaan jam dengan CHIP).
2. Baca pembelian daripada CHIP. **Dibayar** ⇒ sahkan (fungsi yang sama dengan webhook).
3. `pending_*` ⇒ tunggu (bayaran sedang diproses).
4. `cancelled/expired/error/blocked`, atau `POST /cancel/` berjaya ⇒ batalkan tahanan dan
   lepaskan hari (`hold_expired`).
5. CHIP tidak dapat dihubungi ⇒ hari **kekal dikunci**; selepas 30 minit admin diberi emel
   `admin_hold_unresolved`. Cron terus mencuba.

Seorang pelanggan boleh memegang paling banyak **2 tahanan belum bayar** serentak, dan had
5 cubaan / 10 minit setiap IP dan setiap telefon (ADR-007) menghalang tarikh "disorok".

## 3. Lejar (append-only, integer sen, bertanda)

Positif = wang masuk/disimpan perniagaan; negatif = keluar. Pembetulan = entri pembalikan
(`reverses_id`, jenis sama, tanda bertentangan, sekali sahaja). Pangkalan data menolak
UPDATE/DELETE dan tanda yang salah (CHECK + trigger).

| Peristiwa                     | Entri                                                                                                                        |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Bayaran disahkan              | `RENTAL` +, `ADD_ON` +, `MEETUP_FEE` +, `DISCOUNT` −, `DEPOSIT_IN` +, `GATEWAY_FEE` − (fi CHIP sebenar)                      |
| Selesai: caj lewat diluluskan | `DEPOSIT_DEDUCTION` −x, `LATE_FEE` +x                                                                                        |
| Selesai: kerosakan            | `DEPOSIT_DEDUCTION` −y, `DAMAGE_CHARGE` +y                                                                                   |
| Selesai: baki deposit         | `DEPOSIT_REFUND` −(deposit − x − y)                                                                                          |
| Pembatalan → bayaran balik    | `DEPOSIT_REFUND` −min(deposit, amaun); jika amaun < deposit: `DEPOSIT_DEDUCTION` + `CANCELLATION_FEE`; selebihnya `REFUND` − |
| Bayaran tidak sepadan         | Tiada entri (wang itu tidak pernah direkod sebagai pendapatan; rekod di `payments`)                                          |

**Deposit ialah liabiliti, bukan hasil**: baki deposit = jumlah entri `DEPOSIT_*`. Status
`completed` hanya dicapai melalui `/settle`, yang menjadikan baki tepat sifar dalam batch
yang sama. Potongan melebihi baki deposit ditolak — kutip lebihan secara berasingan dan
rekodkan sebagai entri manual (`DAMAGE_CHARGE`, kaedah tunai/DuitNow) dahulu.

### Resit

`R-YYYY-NNNNN`, berjujukan setiap tahun (MYT), diberi dalam batch pengesahan bayaran melalui
`receipt_counters` — tiada lompang, tiada pendua (UNIQUE).

## 4. Pembatalan & bayaran balik

Pengiraan: `cancellationOutcome` (`packages/shared/src/cancellation.ts`) dengan nilai
`settings.cancellation`:

| Bila (sebelum ambil)   | Pelanggan membatalkan                                              |
| ---------------------- | ------------------------------------------------------------------ |
| > 72 jam               | Bayaran balik penuh tolak fi gerbang sebenar                       |
| 24–72 jam              | Tukar tarikh sekali percuma (admin), atau bayaran balik tolak RM30 |
| < 24 jam / tidak hadir | RM30 hangus, selebihnya (termasuk deposit) dipulangkan             |
| Dibatalkan perniagaan  | Semua dipulangkan                                                  |

Admin: `POST /cancel` (rekod `refund_due_sen`, lepaskan hari) → hantar wang secara manual
(DuitNow/CHIP) → `POST /refund` dengan rujukan (lejar + `refunded`). Bayaran balik **tidak**
diautomasikan melalui API CHIP dalam MVP (YAGNI; jumlah kecil, dan admin perlu melihat
setiap kes).

Tukar tarikh (`POST /reschedule`): sekali sahaja, harga mesti sama, unit sama; hari lama
dilepas dan hari baharu dikunci dalam SATU batch — jika mana-mana hari baharu diambil,
tiada apa yang berubah.

## 5. Caj lewat

`lateFeeSen` (shared): dikira dari tamat slot pulang; 30 minit tempoh ihsan; RM15 setiap
blok 6 jam yang bermula; had RM69 setiap 24 jam. Ia **cadangan sahaja** — admin meluluskan
jumlah semasa `/settle`. Cron menandakan `overdue` selepas tempoh ihsan dan memaklumkan admin.

## 6. Risiko & perkara terbuka

- Fi CHIP sebenar direkod daripada `payment.fee_amount`; jika CHIP tidak memulangkannya,
  `GATEWAY_FEE` tidak direkod — semak penyata CHIP bulanan.
- Callback CHIP tidak dapat sampai ke `localhost`; secara tempatan pengesahan hanya melalui
  rekonsiliasi cron. Uji aliran penuh di **staging dengan kunci ujian CHIP** sebelum live.
- Kunci awam CHIP dicache per isolate; jika CHIP menukar kunci, isolate baharu akan
  mengambilnya. Jika dipin (`CHIP_PUBLIC_KEY`), kemas kini secret itu.
