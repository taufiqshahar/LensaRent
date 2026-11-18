# Runbook & sandaran manual

Untuk pemilik/admin. Setiap seksyen: **tanda → apa yang berlaku → apa yang perlu dibuat**.
Prinsip: jangan sunting pangkalan data dengan tangan; gunakan panel admin, yang mengaudit
setiap perubahan. Jika panel tidak boleh digunakan, catat di atas kertas dan masukkan
kemudian.

## Rutin harian

| Bila          | Tindakan                                                                                                                          |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 08:00         | Baca emel "Ringkasan …" (ambil & pulang hari ini). Buka **Admin → Hari ini**.                                                     |
| Sebelum serah | Tempahan → **Sedia untuk diambil**; muat naik ≥1 gambar kamera; isi 4 digit MyKad, senarai semak → **Serah**.                     |
| Semasa pulang | Muat naik ≥1 gambar; **Terima & periksa**; semak cadangan caj lewat; **Selesai & pulangkan deposit** (DuitNow), masukkan rujukan. |
| 18:00         | Pelanggan esok menerima emel peringatan secara automatik.                                                                         |

Jangan sekali-kali ambil gambar atau salinan MyKad. Hanya 4 digit terakhir.

## Insiden

### Pelanggan kata sudah bayar, tetapi status "Menunggu bayaran"

1. Tunggu 5 minit — callback CHIP mungkin lewat; cron menyemak setiap minit selepas tahanan tamat.
2. Semak pembelian di dashboard CHIP (cari kod `PK-…` dalam _reference_).
3. Jika CHIP kata _paid_ tetapi status masih belum berubah selepas 10 minit: semak emel
   `admin_hold_unresolved`, dan log Worker (`payment.*`, `cron.*`). Jangan cipta tempahan
   kedua untuk tarikh yang sama.

### Emel "TINDAKAN DIPERLUKAN: masalah bayaran"

Amaun/mata wang/rujukan tidak sepadan, atau bayaran tiba selepas tempahan ditutup. Tarikh
sudah dilepaskan. Hubungi pelanggan, pulangkan wang melalui CHIP/DuitNow, kemudian
**Rekod bayaran balik** dalam panel (tempahan `refund_pending`).

### CHIP tidak berfungsi

Tempahan baharu menerima "Sistem pembayaran tidak dapat dihubungi" dan tarikh **tidak**
ditahan. Terima tempahan melalui WhatsApp; minta bayaran DuitNow; selepas CHIP pulih,
pelanggan boleh menempah dalam talian. Jika perlu tutup tempahan dalam talian sepenuhnya:
`wrangler secret delete CHIP_SECRET_KEY --env production` (borang memaparkan mesej "belum dibuka").

### Laman/Worker tidak berfungsi

1. Semak https://www.cloudflarestatus.com.
2. Teruskan melalui WhatsApp dengan kertas: rujukan, nama, telefon, tarikh, deposit, 4 digit MyKad.
3. Deploy terakhir yang baik: `wrangler rollback --env production` (lihat `wrangler deployments list`).

### Emel tidak sampai

Status `pending` dalam outbox dicuba semula (2, 4, 8 … minit, 6 kali). Semak `RESEND_API_KEY`,
domain pengirim disahkan di Resend, dan log `email.failed`. Hubungi pelanggan melalui WhatsApp
— pautan status tempahan juga boleh dilihat dari pelayar yang digunakan untuk menempah.

### Kamera rosak / unit perlu dibaiki

**Unit & blok → Sekat tarikh** untuk hari pembaikan. Unit dengan tempahan akan datang tidak
boleh ditukar kepada _Penyelenggaraan/Bersara_ — batalkan atau tukar tarikh tempahan itu dahulu.

### Kesilapan dalam lejar

Jangan padam. Dalam tempahan → **Lejar → Balikkan** (dengan sebab), kemudian tambah entri betul.

## Sandaran & pemulihan

Dua lapisan:

1. **D1 Time Travel** (point-in-time: 30 hari pada Workers Paid, 7 hari pada Free):
   ```bash
   wrangler d1 time-travel info lensarent-production
   wrangler d1 time-travel restore lensarent-production --timestamp=2026-12-01T03:00:00Z
   ```
   Ini menulis ganti pangkalan data — **hentikan dahulu** semua kerja admin; selepas itu
   semak tempahan sejak masa itu di dashboard CHIP.
2. **Eksport malam** (`.github/workflows/backup.yml`) ke bucket R2 peribadi
   `lensarent-backups/d1/<env>/<masa>.sql.gz`, setiap satu **disahkan** dengan memulihkannya
   ke pangkalan data sementara (`apps/worker/scripts/verify-backup.sh`).

Pulih daripada eksport ke pangkalan data baharu (tidak menyentuh yang lama):

```bash
wrangler r2 object get lensarent-backups/d1/production/<masa>.sql.gz --file d1.sql.gz --remote
gunzip d1.sql.gz
apps/worker/scripts/verify-backup.sh d1.sql             # semak dahulu
wrangler d1 create lensarent-restore --location apac
wrangler d1 execute lensarent-restore --remote --file d1.sql
# kemudian tukar database_id dalam wrangler.toml [env.production] dan deploy
```

Diuji secara tempatan (18 Nov 2026): eksport → pulih ke D1 baharu → bilangan baris sama,
trigger append-only aktif.

Foto serahan dalam R2 **tidak** disandarkan (bukti sementara, dipadam selepas
`retention.photoDays`).
