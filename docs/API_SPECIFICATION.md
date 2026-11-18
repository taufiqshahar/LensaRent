# Spesifikasi API

Semua endpoint di bawah `/api/*` pada origin yang sama dengan laman, jadi tiada CORS.
Badan permintaan dan respons dalam JSON (`application/json`), kecuali eksport CSV.

**Status:** Fasa 1 (lead) dan Fasa 2 (tempahan, bayaran, operasi admin). Butiran aliran
bayaran: `PAYMENT_AND_DEPOSIT_SPEC.md`.

## Konvensyen

- **Ralat** sentiasa berbentuk:
  ```json
  {
    "error": {
      "code": "VALIDATION_FAILED",
      "message": "Sila semak maklumat yang diisi.",
      "fields": { "phone": "…" }
    }
  }
  ```
  `message` ialah ayat Bahasa Melayu yang selamat dipaparkan kepada pengguna. `fields` (jika
  ada) memberi satu mesej BM bagi setiap medan yang salah. Input mentah tidak pernah
  dipantulkan; tiada stack trace.
- **Badan permintaan** mesti `Content-Type: application/json` dan ≤ 16 KiB. Medan yang
  tidak dikenali ditolak.
- **Respons** membawa `Cache-Control: no-store` dan header keselamatan (`lib/http.ts`).
- **Had kadar** dijawab `429` dengan `Retry-After` (saat).
- **Admin**: `/admin/*` dan `/api/admin/*` dilindungi **Cloudflare Access**. Worker
  mengesahkan header `Cf-Access-Jwt-Assertion` (tandatangan, issuer, AUD, tamat tempoh)
  dan menyemak emel dalam `ADMIN_EMAILS`. Permintaan admin yang mengubah data mesti
  membawa `Origin` yang sama dengan laman.

| Kod                      | HTTP | Bila                                                    |
| ------------------------ | ---- | ------------------------------------------------------- |
| `VALIDATION_FAILED`      | 400  | Input tidak sah (dengan `fields`)                       |
| `INVALID_JSON`           | 400  | Badan bukan JSON yang sah                               |
| `UNAUTHENTICATED`        | 401  | Tiada sesi admin yang sah                               |
| `TURNSTILE_FAILED`       | 403  | Pengesahan Turnstile gagal                              |
| `FORBIDDEN_ORIGIN`       | 403  | Permintaan admin bukan dari origin sendiri              |
| `NOT_FOUND`              | 404  | Laluan atau rekod tidak wujud                           |
| `METHOD_NOT_ALLOWED`     | 405  | Kaedah salah (header `Allow` disertakan)                |
| `PAYLOAD_TOO_LARGE`      | 413  | Badan > 16 KiB                                          |
| `UNSUPPORTED_MEDIA_TYPE` | 415  | Bukan `application/json`                                |
| `RATE_LIMITED`           | 429  | Melepasi had (`Retry-After`)                            |
| `INTERNAL_ERROR`         | 500  | Ralat tidak dijangka (butiran dalam log yang diredaksi) |

## Awam

### `GET /api/health`

Hidup atau tidak. Tidak menyentuh backend.

`200` → `{ "status": "ok", "environment": "production", "time": "2026-11-12T08:00:00.000Z" }`

### `POST /api/leads`

Borang minat. Turutan semakan: burst limiter → validasi → Turnstile (`action: "lead"`) →
had per IP (10/jam) dan per telefon (3/hari) → simpan.

```json
{
  "name": "Nur Aisyah",
  "phone": "017-491 3169",
  "desiredDate": "2026-12-24",
  "usage": "travel",
  "source": "tiktok",
  "consent": true,
  "turnstileToken": "<token daripada widget>"
}
```

| Medan            | Peraturan                                                                            |
| ---------------- | ------------------------------------------------------------------------------------ |
| `name`           | 2–80 aksara selepas trim; tiada aksara kawalan                                       |
| `phone`          | Nombor bimbit Malaysia dalam apa-apa format biasa; disimpan sebagai E.164            |
| `desiredDate`    | `yyyy-MM-dd`, hari ini (MYT) hingga 365 hari ke depan; `""` atau tiada = belum pasti |
| `usage`          | `vlog` `travel` `event` `content` `family` `other`                                   |
| `source`         | `tiktok` `instagram` `facebook` `whatsapp` `google` `friend` `other`                 |
| `consent`        | Mesti `true`                                                                         |
| `turnstileToken` | Token widget, sekali guna                                                            |

`201` → `{ "ok": true }` · `400` `VALIDATION_FAILED` · `403` `TURNSTILE_FAILED` · `415` · `429`

### `GET /api/config`

Apa yang perlu oleh borang `/tempah`: `bookingOpen` (CHIP dikonfigurasi + ada slot aktif +
ada unit aktif), `today` (MYT), `maxDaysAhead`, `pricing`, `depositSen`, tambahan aktif,
lokasi aktif, slot aktif, `minLeadHours`, `maxRentalDays`, `holdMinutes`, `policyVersions`.
Semuanya maklumat awam.

### `GET /api/availability?from=yyyy-MM-dd&to=yyyy-MM-dd`

Julat ≤ 62 hari, dipotong ke hari ini … ufuk tempahan. Respons
`{ from, to, unavailable: ["yyyy-MM-dd", …] }` — hari tanpa unit kosong. Petunjuk kalendar
sahaja (tidak mendedahkan bilangan unit); semakan sebenar ialah hold.

### `POST /api/quote`

Badan: `pickupDate`, `pickupSlotId`, `pickupLocationId`, `returnDate`, `returnSlotId`,
`returnLocationId`, `addOns: [{code, qty}]`. **Tiada telefon** (ia akan mendedahkan tahap
pelanggan). Respons: `rentalDays`, `pickupAt`, `returnAt`, `returnSlotEnd`, `addOnLines`,
`includedItems`, `breakdown{rentalSen, addOnsSen, meetupSen, discountSen, depositSen,
totalPayableSen}`, `available`. Masalah tempoh dijawab `400` dengan medan yang perlu diubah.

### `POST /api/bookings/hold`

Badan: medan quote + `name`, `phone`, `email`, `consent{terms:true, privacy:true}`,
`turnstileToken` (action `booking`). Urutan: had burst → zod → peraturan tempoh → Turnstile
→ had D1 (5/10 min setiap IP dan telefon) → pelanggan (disekat ⇒ `403 BOOKING_NOT_ALLOWED`;
≥ 2 tahanan terbuka ⇒ `409 TOO_MANY_HOLDS`) → kunci hari pada unit kosong pertama
(`409 SLOT_UNAVAILABLE`) → pembelian CHIP (`502 PAYMENT_UNAVAILABLE`, tahanan dibatalkan).
CHIP tidak dikonfigurasi ⇒ `503 BOOKING_CLOSED`.
`201`: `{ refCode, lookupToken, checkoutUrl, holdExpiresAt, breakdown }`.

### `GET /api/bookings/lookup?ref=PK-XXXXXX`

Header `X-Booking-Token: <lookupToken>`. Rujukan atau token salah ⇒ `404` yang sama.
Respons tanpa data peribadi: `refCode`, `status`, masa & lokasi, `rentalDays`, `addOns`,
`breakdown`, `holdExpiresAt`, `checkoutUrl` (hanya jika tahanan masih sah), `receiptNo`.

### `POST /api/webhooks/chip`

`success_callback` CHIP. `401` jika `X-Signature` tidak sah. Selepas sah: idempotensi pada
`purchaseId:event_type`, pembelian dibaca semula, kemudian `settlePayment`. `2xx` hanya
apabila selesai (`confirmed`, `already_processed`, `mismatch`, `paid_after_close`,
`not_paid`, `ignored`); selain itu bukan-2xx supaya CHIP mencuba semula.

## Admin

Log masuk dan log keluar diuruskan oleh Cloudflare Access (log keluar:
`/cdn-cgi/access/logout`). Tiada endpoint log masuk dalam API.

### `GET /api/admin/me`

`200` → `{ "email": "admin@contoh.my" }` · `401`

### `GET /api/admin/leads`

| Parameter    | Maksud                                                               |
| ------------ | -------------------------------------------------------------------- |
| `status`     | Tapis status (`new` `contacted` `converted` `not_interested` `spam`) |
| `from`, `to` | Hari (MYT, inklusif) lead dihantar, `yyyy-MM-dd`                     |
| `limit`      | 1–200, lalai 50                                                      |
| `before`     | Penanda halaman: `nextBefore` daripada respons sebelumnya            |

`200` →

```json
{
  "leads": [
    {
      "id": "Xk2pQ9LmN4vR7sT1uW3y",
      "name": "Nur Aisyah",
      "phoneE164": "+60174913169",
      "desiredDate": "2026-12-24",
      "usage": "travel",
      "source": "tiktok",
      "status": "new",
      "notes": "",
      "createdAt": "2026-11-12T07:47:00.000Z",
      "updatedAt": "2026-11-12T07:47:00.000Z"
    }
  ],
  "nextBefore": "2026-11-12T07:47:00.000Z~Xk2pQ9LmN4vR7sT1uW3y"
}
```

Paling baharu dahulu (`created_at`, kemudian `id`, jadi lead dengan cap masa sama tidak
hilang atau berulang antara halaman). `nextBefore` ialah `null` pada halaman terakhir.
`400` untuk penapis tidak sah · `401`

### `GET /api/admin/leads/export`

Penapis yang sama (`status`, `from`, `to`). `200 text/csv` (UTF-8 dengan BOM, CRLF),
`Content-Disposition: attachment; filename="leads-YYYY-MM-DD.csv"`, maksimum 5,000 baris.
Lajur: Dihantar (MYT), Nama, Telefon, Tarikh diingini, Kegunaan, Sumber, Status, Nota.
Sel yang bermula dengan `= + - @` diteutralkan.

### `PUT /api/admin/leads/:id`

`{ "status": "contacted" }`, `{ "notes": "…" }`, atau kedua-duanya (nota ≤ 2,000 aksara).

`200` → `{ "ok": true }`. Entri `audit_logs` (nama medan yang berubah sahaja) ditulis dalam
transaksi yang sama, dan hanya jika lead itu wujud. `400` · `401` · `403 FORBIDDEN_ORIGIN` · `404`

### Tempahan (Fasa 2)

Setiap tindakan mengubah menghantar `from` (status yang dilihat admin). Status sudah berubah
⇒ `409 BOOKING_CHANGED`; peralihan dilarang ⇒ `409 INVALID_TRANSITION`.

| Kaedah & laluan                              | Badan / query                                                          | Kesan                                                                                                               |
| -------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `GET /api/admin/bookings`                    | `status`, `day` (MYT: ambil atau pulang hari itu), `before`, `limit`   | Senarai terbaru dahulu; kursor `<createdAt>~<id>` dalam `next`                                                      |
| `GET /api/admin/bookings/:id`                | —                                                                      | Tempahan, event, bayaran, lejar, foto, baki deposit, peralihan dibenarkan, cadangan caj lewat, pratonton pembatalan |
| `POST /api/admin/bookings/:id/transition`    | `{from, to: ready_for_pickup \| disputed, reason}`                     | Peralihan tanpa data tambahan                                                                                       |
| `POST /api/admin/bookings/:id/cancel`        | `{from, initiator: customer \| business \| no_show, reason}`           | Tahanan: batal CHIP dahulu → `cancelled`. Dibayar: `refund_pending` + `refund_due_sen`, hari dilepas                |
| `POST /api/admin/bookings/:id/refund`        | `{from: refund_pending, amountSen, method, reference, note}`           | Rekod bayaran balik yang dihantar → `refunded`                                                                      |
| `POST /api/admin/bookings/:id/photos?stage=` | badan = imej mentah (JPEG/PNG/WebP, ≤ 8 MB)                            | Simpan dalam R2                                                                                                     |
| `POST /api/admin/bookings/:id/handover`      | `{from, idLast4, checklist, accessories, note}`                        | Perlu ≥1 foto `checkout` (`409 PHOTO_REQUIRED`) → `active_rental`                                                   |
| `POST /api/admin/bookings/:id/return`        | `{from, returnedAt?, checklist, accessories, note}`                    | Perlu ≥1 foto `return` → `return_inspection`; balas `lateFeeSuggestionSen`                                          |
| `POST /api/admin/bookings/:id/settle`        | `{from, lateFeeSen, damageSen, refundMethod, refundReference, note}`   | Potongan ≤ baki deposit; lejar; → `completed`; pelanggan `returning`                                                |
| `POST /api/admin/bookings/:id/ledger`        | `{type, amountSen, method, reference, note}` atau `{reversesId, note}` | Entri manual bertanda, atau pembalikan (sekali)                                                                     |
| `POST /api/admin/bookings/:id/reschedule`    | `{from, period: <badan quote>}`                                        | Sekali, harga sama, unit sama, satu batch                                                                           |
| `GET /api/admin/photos/:id`                  | —                                                                      | Imej, `no-store`                                                                                                    |

### Armada, pelanggan, tetapan, audit

| Kaedah & laluan                     | Nota                                                                                     |
| ----------------------------------- | ---------------------------------------------------------------------------------------- |
| `GET/POST /api/admin/units`         | Cipta: `{id, name, model, serialNumber, status, accessories, sortOrder}`                 |
| `PUT /api/admin/units/:id`          | Tidak boleh meninggalkan `active` jika ada tempahan akan datang (`UNIT_HAS_BOOKINGS`)    |
| `GET/POST /api/admin/blocks`        | `{unitId, from, to, reason}` → kunci `maintenance`; konflik ⇒ `409` + `conflictingDates` |
| `DELETE /api/admin/blocks/:id`      | Lepaskan hari blok                                                                       |
| `GET /api/admin/calendar?from&to`   | Semua kunci (≤ 62 hari) dengan rujukan/status tempahan                                   |
| `GET /api/admin/customers?phone=`   | Carian tepat melalui hash telefon; tanpa `phone` = 100 terkini                           |
| `PUT /api/admin/customers/:id`      | `{tier, blocked, notes}`                                                                 |
| `GET /api/admin/settings`           | Nilai berkesan + senarai kunci yang boleh diubah (ADR-020)                               |
| `PUT /api/admin/settings/:key`      | `{value}`, disahkan zod; kunci lain ⇒ `404`                                              |
| `GET /api/admin/audit-logs?before=` | 100 setiap halaman                                                                       |

Setiap perubahan admin menulis `audit_logs` dalam batch yang sama.
