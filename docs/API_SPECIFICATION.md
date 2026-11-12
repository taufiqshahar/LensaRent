# Spesifikasi API

Semua endpoint di bawah `/api/*` pada origin yang sama dengan laman, jadi tiada CORS.
Badan permintaan dan respons dalam JSON (`application/json`), kecuali eksport CSV.

**Status:** endpoint Fasa 1 sahaja. Endpoint tempahan, webhook dan operasi admin lain
(master prompt §10) ditambah pada Fasa 2.

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
- **Admin**: cookie sesi `__Host-lensarent_admin` (HttpOnly, Secure, SameSite=Strict).
  Permintaan admin yang mengubah keadaan mesti membawa `Origin` yang sama dengan laman.

| Kod                      | HTTP | Bila                                                    |
| ------------------------ | ---- | ------------------------------------------------------- |
| `VALIDATION_FAILED`      | 400  | Input tidak sah (dengan `fields`)                       |
| `INVALID_JSON`           | 400  | Badan bukan JSON yang sah                               |
| `UNAUTHENTICATED`        | 401  | Tiada sesi admin yang sah                               |
| `LOGIN_FAILED`           | 401  | Log masuk gagal (sebab tidak didedahkan)                |
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

## Admin

### `POST /api/admin/session` — log masuk

`{ "email": "…", "password": "…" }`

`200` → `{ "email": "admin@contoh.my", "expiresAt": "…" }` dengan `Set-Cookie`.

Semua kegagalan (kata laluan salah, akaun tiada, akaun dinyahaktif, bukan admin, badan
tidak sah) → `401 LOGIN_FAILED` yang sama. Had: 10 / 15 min per IP, 5 / 15 min per emel
(`429`). `403 FORBIDDEN_ORIGIN` jika `Origin` lain.

### `GET /api/admin/session`

`200` → `{ "email", "expiresAt", "idleExpiresAt" }` · `401`

### `DELETE /api/admin/session` — log keluar

`204` dengan cookie dikosongkan. Sesi dipadam di pelayan. Perlu `Origin` sama.

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
  "nextBefore": "2026-11-12T07:47:00.000Z"
}
```

Paling baharu dahulu. `nextBefore` ialah `null` pada halaman terakhir.
`400` untuk penapis tidak sah · `401`

### `GET /api/admin/leads/export`

Penapis yang sama (`status`, `from`, `to`). `200 text/csv` (UTF-8 dengan BOM, CRLF),
`Content-Disposition: attachment; filename="leads-YYYY-MM-DD.csv"`, maksimum 5,000 baris.
Lajur: Dihantar (MYT), Nama, Telefon, Tarikh diingini, Kegunaan, Sumber, Status, Nota.
Sel yang bermula dengan `= + - @` diteutralkan.

### `PUT /api/admin/leads/:id`

`{ "status": "contacted" }`, `{ "notes": "…" }`, atau kedua-duanya (nota ≤ 2,000 aksara).

`200` → `{ "ok": true }`. Entri `auditLogs` (nama medan yang berubah sahaja) ditulis dalam
commit yang sama. `400` · `401` · `403 FORBIDDEN_ORIGIN` · `404`
