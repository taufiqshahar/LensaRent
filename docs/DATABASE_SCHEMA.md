# Skema Pangkalan Data (Cloudflare D1)

D1 ialah SQLite terurus Cloudflare, dicipta di rantau Asia Pasifik (`--location apac`).
Skema yang sebenar ialah fail migrasi dalam `apps/worker/migrations/`. Dokumen ini
menerangkannya; jika bercanggah, **migrasi yang betul**.

**Status:** Fasa 1. Jadual yang wujud: `leads`, `availability_locks`, `rate_limits`,
`audit_logs`. Jadual Fasa 2 ditambah dalam migrasi baharu (senarai di bawah).

## Peraturan umum

- **Worker ialah lapisan penguatkuasaan utama**: input disahkan dengan zod sebelum ditulis.
  Skema SQL menjadi **lapisan kedua**: PRIMARY KEY, `CHECK` untuk setiap enum dan format,
  dan trigger untuk jadual append-only.
- Jadual `STRICT`: SQLite menolak nilai dengan jenis yang salah.
- Masa: rentetan ISO-8601 UTC yang ditulis Worker (`2026-11-18T08:00:00.000Z`). Ia boleh
  disusun sebagai teks dan mudah dibaca di konsol D1. Hari kalendar ialah `yyyy-MM-dd` dalam
  waktu Malaysia.
- Wang (Fasa 2): `INTEGER` sen, dengan `CHECK (typeof(x) = 'integer')`.
- ID: 20 aksara rawak (`newId()`) kecuali jika dinyatakan lain.
- Pengecam peribadi yang menjadi kunci (telefon, IP) **sentiasa di-hash** dahulu (HMAC
  dengan `PHONE_HASH_PEPPER`).
- Transaksi: `db.batch([...])`. Lihat [DECISIONS.md, ADR-017](DECISIONS.md) untuk semantik
  dan satu perangkapnya.

## `leads` — borang minat

| Lajur                      | Jenis     | Kekangan                                                             |
| -------------------------- | --------- | -------------------------------------------------------------------- |
| `id`                       | TEXT PK   | 20 aksara                                                            |
| `name`                     | TEXT      | 2–80 aksara                                                          |
| `phone_e164`               | TEXT      | `+601…` (bimbit Malaysia)                                            |
| `phone_hash`               | TEXT      | HMAC (`phone:`), untuk had kadar                                     |
| `desired_date`             | TEXT NULL | `yyyy-MM-dd`; NULL = belum pasti                                     |
| `usage`                    | TEXT      | `vlog` `travel` `event` `content` `family` `other`                   |
| `source`                   | TEXT      | `tiktok` `instagram` `facebook` `whatsapp` `google` `friend` `other` |
| `status`                   | TEXT      | `new` `contacted` `converted` `not_interested` `spam` (lalai `new`)  |
| `notes`                    | TEXT      | ≤ 2,000 aksara; admin sahaja                                         |
| `privacy_version`          | TEXT      | Versi notis privasi yang dipersetujui                                |
| `consent_at`               | TEXT      | Masa persetujuan                                                     |
| `created_at`, `updated_at` | TEXT      | ISO UTC                                                              |

Index: `(created_at DESC, id DESC)`, `(status, created_at DESC, id DESC)`, `(phone_hash)`.
Tiada IP mentah disimpan.

## `availability_locks` — anti double-booking

Satu baris per unit per hari. **Baris wujud = hari itu dikunci.**

| Lajur             | Jenis                         | Nota                                           |
| ----------------- | ----------------------------- | ---------------------------------------------- |
| `unit_id`, `date` | TEXT, **PRIMARY KEY bersama** | Tuntutan kedua ke atas hari yang sama mustahil |
| `kind`            | TEXT                          | `hold` `booking` `maintenance`                 |
| `booking_id`      | TEXT NULL                     | Pemilik bagi `hold` / `booking`                |
| `block_id`        | TEXT NULL                     | Pemilik bagi `maintenance`                     |
| `hold_expires_at` | TEXT NULL                     | Wajib untuk `hold` sahaja                      |
| `created_at`      | TEXT                          |                                                |

`CHECK` memastikan tepat satu pemilik (booking **atau** blok), dan hanya `hold` yang ada
masa tamat. Semua hari bagi satu tempahan dimasukkan dalam satu batch (`acquireDayLocks`);
pelepasan ialah DELETE (`releaseDayLocks`). `WITHOUT ROWID`. Index separa pada `booking_id`.

## `rate_limits`

`key` (PK: `<rule>:<hash>:<window>`), `count` (≥ 1), `expires_at`. Satu upsert
`… ON CONFLICT DO UPDATE SET count = count + 1 RETURNING count`. Baris tamat dipadam dalam
batch yang sama melalui index `expires_at`. Lihat ADR-007.

## `audit_logs`

| Lajur                       | Nota                                           |
| --------------------------- | ---------------------------------------------- |
| `id`                        | PK                                             |
| `actor_id`, `actor_email`   | Admin daripada Cloudflare Access (`sub`, emel) |
| `action`                    | Contoh `lead.update`                           |
| `target_table`, `target_id` | Rekod yang berubah                             |
| `changed_fields`            | JSON nama medan sahaja, **tiada nilai**        |
| `at`                        | ISO UTC                                        |

**Append-only dikuatkuasakan oleh pangkalan data**: trigger `BEFORE UPDATE` dan
`BEFORE DELETE` menolak sebarang perubahan (diuji).

## Fasa 2 — `migrations/0002_bookings.sql`

| Jadual                 | Isi & kekangan utama                                                                                                                                                                                                                                                                                                             |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `settings`             | Kunci admin-editable sahaja (ADR-020); `value` JSON sah                                                                                                                                                                                                                                                                          |
| `units`                | `status` active/maintenance/retired; aksesori JSON                                                                                                                                                                                                                                                                               |
| `customers`            | Satu per telefon (`phone_hash` UNIQUE); `tier`, `completed_count`, `blocked`, nota                                                                                                                                                                                                                                               |
| `bookings`             | Snapshot pelanggan, slot & masa, `locked_dates`, harga dalam sen dengan CHECK `total = sewa + tambahan + lokasi − diskaun + deposit`; `status` CHECK; `last_transition_id` (ADR-021); `hold_expires_at` wujud ⇔ `pending_payment`; `refund_due_sen` wajib dalam `refund_pending`; `id_last4` 4 digit sahaja; `receipt_no` UNIQUE |
| `booking_events`       | Sejarah status; append-only (trigger)                                                                                                                                                                                                                                                                                            |
| `payments`             | `provider_ref` UNIQUE; `expected_sen` > 0; `status` created/paid/mismatch/cancelled; `is_test`                                                                                                                                                                                                                                   |
| `ledger_entries`       | Append-only (trigger); `amount_sen` integer ≠ 0; tanda ditentukan jenis, atau bertentangan jika `reverses_id` (UNIQUE: satu pembalikan sahaja)                                                                                                                                                                                   |
| `webhook_events`       | PK `(provider, event_key)`; dipadam selepas 90 hari                                                                                                                                                                                                                                                                              |
| `notifications_outbox` | Emel menunggu/dihantar/gagal; `dedupe_key` UNIQUE; payload id sahaja                                                                                                                                                                                                                                                             |
| `receipt_counters`     | Satu baris setiap tahun MYT; `last_number` naik dalam batch pengesahan                                                                                                                                                                                                                                                           |
| `maintenance_blocks`   | Hari-harinya ialah `availability_locks` jenis `maintenance`                                                                                                                                                                                                                                                                      |
| `handover_photos`      | Metadata objek R2; `content_type` jpeg/png/webp; ≤ 8 MB; `deleted_at` selepas tempoh simpan                                                                                                                                                                                                                                      |

Indeks: status + pickup, pickup, return slot end, pelanggan, tamat tahanan (separa), lejar
ikut tempahan, outbox ikut `status, send_after`.

## Mengubah skema

1. Tambah fail baharu `apps/worker/migrations/000N_<nama>.sql`. **Jangan sunting migrasi
   yang telah digunakan.**
2. `pnpm test` (ujian menggunakan semua migrasi pada D1 tempatan).
3. `wrangler d1 migrations apply DB --env staging`, uji, kemudian `--env production`.
