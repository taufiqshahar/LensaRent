# Deployment & Backup

**Status:** langkah di bawah sedia untuk dijalankan tetapi **belum pernah dijalankan**
(akaun Cloudflare dan domain belum disediakan). Semuanya dalam **satu akaun Cloudflare**.

## 1. Persediaan sekali (staging dahulu, kemudian production)

### Domain

Tambah domain ke Cloudflare (nameserver Cloudflare). Staging menggunakan subdomain,
contohnya `staging.<domain>`, supaya ia juga dilindungi Access.

### Pangkalan data D1

```sh
cd apps/worker
wrangler d1 create lensarent-staging --location apac
```

Salin `database_id` yang dicetak ke `[[env.staging.d1_databases]]` dalam `wrangler.toml`,
kemudian:

```sh
wrangler d1 migrations apply DB --env staging --remote
```

### Cloudflare Access (log masuk admin)

1. Zero Trust → Settings: pilih nama pasukan, contohnya `lensarent`. Ini menjadi
   `lensarent.cloudflareaccess.com`.
2. Settings → Authentication: aktifkan **One-time PIN**. Google juga boleh ditambah.
3. Access → Applications → Add → **Self-hosted**:
   - Domain: `staging.<domain>`, path `admin`, **dan** path `api/admin` (kedua-duanya).
   - Polisi: **Allow** → Emails → emel admin anda.
   - Session duration: 24 jam atau kurang.
4. Salin **Application Audience (AUD) Tag** aplikasi itu.
5. Isi dalam `wrangler.toml` `[env.staging.vars]`:
   - `ACCESS_TEAM_DOMAIN = "lensarent.cloudflareaccess.com"`
   - `ACCESS_AUD = "<tag AUD>"`
   - `ADMIN_EMAILS = "anda@contoh.my"` (mesti sama dengan polisi; Worker menyemak semula)

Menambah atau membuang admin = ubah **polisi Access dan** `ADMIN_EMAILS`, kemudian deploy.

### Turnstile

Cipta widget untuk hostname staging. Site key → `apps/web/.env.staging`
(`VITE_TURNSTILE_SITE_KEY`, juga set `VITE_SITE_ORIGIN`). Secret key → secret Worker.

### Secret Worker

Nilai ditaip semasa diminta dan tidak pernah dipaparkan:

```sh
wrangler secret put TURNSTILE_SECRET_KEY --env staging
wrangler secret put PHONE_HASH_PEPPER --env staging     # openssl rand -base64 48
```

⚠️ **Jangan tukar `PHONE_HASH_PEPPER` selepas ada data** (hash lama tidak akan sepadan).
Simpan salinannya dalam pengurus kata laluan.

### Lain-lain

- `namespace_id` rate limit dalam `wrangler.toml` (1001 staging, 1002 production) mesti
  unik dalam akaun.
- Route domain tersuai: tambah dalam `wrangler.toml` apabila domain muktamad, dan
  `workers_dev = false`.

## 2. Deploy

```sh
pnpm test                                           # mesti hijau
cd apps/worker && wrangler d1 migrations apply DB --env staging --remote && cd ../..

# Staging
pnpm --filter @lensarent/web build                  # mod staging: banner DRAF, noindex
cd apps/worker && wrangler deploy --env staging

# Production — build gagal selagi ada draf / kunci ujian / tiada VITE_SITE_ORIGIN
pnpm --filter @lensarent/web build:production
cd apps/worker && wrangler d1 migrations apply DB --env production --remote
wrangler deploy --env production
```

Worker enggan berjalan di staging/production jika `ACCESS_DEV_EMAIL` diset, atau jika
binding/secret tertinggal (`500` generik; butiran dalam Workers Logs).

## 3. Semakan selepas deploy (staging dahulu)

- [ ] `GET /api/health` → `200`, `environment` betul.
- [ ] Semua halaman awam dibuka; header CSP hadir (`curl -I`).
- [ ] Borang minat dengan **widget Turnstile sebenar** → lead muncul di `/admin/`.
      Ini juga mengesahkan CSP Turnstile, yang tidak dapat diuji dalam sesi pembangunan.
- [ ] `/admin/` meminta log masuk Access (OTP ke emel). Emel lain → kod tidak dihantar.
- [ ] Tukar status, nota, eksport CSV, log keluar (`/cdn-cgi/access/logout`).
- [ ] `curl https://staging.<domain>/api/admin/leads` tanpa log masuk → `401` atau halaman
      log masuk Access.
- [ ] Jika `*.workers.dev` masih aktif: `/api/admin/leads` di situ → `401`.
- [ ] iOS Safari & Android Chrome: borang dan admin.

### Fasa 2 (staging, kunci UJIAN CHIP)

- [ ] Tetapkan slot sebenar dalam **Admin → Tetapan → handoverSlots**; tambah unit aktif.
- [ ] `/tempah` → hold → halaman CHIP ujian → bayar → kembali ke `/tempahan` → "Disahkan";
      emel pengesahan + emel admin diterima; resit `R-YYYY-00001`.
- [ ] Biarkan satu hold tamat tanpa bayar → selepas ~2 minit status "Dibatalkan", tarikh kosong.
- [ ] Kitaran admin: sedia → foto → serah → foto → pulang → selesai deposit; semak lejar baki 0.
- [ ] Pembatalan + rekod bayaran balik; tukar tarikh sekali.
- [ ] Jalankan `Backup D1` secara manual (`workflow_dispatch`, environment `staging`).

## 4. Backup

- **D1 Time Travel**: pulih ke mana-mana minit dalam 7 hari (Free) atau 30 hari (Workers
  Paid). Contoh: `wrangler d1 time-travel restore lensarent-production --timestamp=<ISO>`.
  Ia menimpa pangkalan data semasa, jadi **uji ke staging dahulu**.
- **Salinan luar talian**: `.github/workflows/backup.yml` setiap malam 03:23 MYT —
  eksport, **pulih ke D1 sementara dan semak** (`apps/worker/scripts/verify-backup.sh`),
  kemudian muat naik ke bucket R2 peribadi `lensarent-backups`. Prosedur pemulihan penuh:
  `RUNBOOK_MANUAL_FALLBACK.md`. Diuji tempatan 18 Nov 2026.
- Persediaan: `wrangler r2 bucket create lensarent-backups`; peraturan lifecycle padam
  selepas 90 hari; secret repo `CLOUDFLARE_API_TOKEN` (kebenaran D1 Edit + R2 Edit sahaja)
  dan `CLOUDFLARE_ACCOUNT_ID`. Tanpa secret, job melangkau dengan amaran.

Arahan dan pilihan di atas disahkan dengan `--help` wrangler 4.160. ⚠️ Tempoh 7/30 hari
mengikut pelan diambil daripada sumber sekunder; sahkan di halaman harga.
