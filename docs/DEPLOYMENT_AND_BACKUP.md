# Deployment & Backup

**Status:** semua langkah di bawah sedia untuk dijalankan, tetapi **belum pernah dijalankan**
kerana akaun Firebase/Cloudflare belum disediakan. Backup harian (export Firestore) ialah
Fasa 2.

## 1. Sediakan sekali (setiap environment: staging, kemudian production)

### Firebase

1. Cipta projek (cth. `lensarent-staging`, `lensarent-production`), lokasi Firestore
   **`asia-southeast1`**, mod Native.
2. Authentication → aktifkan **Email/Password**. Cipta akaun admin di tab Users (kata
   laluan kukuh, ≥ 16 aksara).
3. Project settings → salin **Web API key** (untuk secret `FIREBASE_API_KEY`). Di Google
   Cloud Console → Credentials, **hadkan kunci itu kepada Identity Toolkit API** sahaja.
4. Service account untuk Worker: IAM → cipta service account dengan peranan
   **Cloud Datastore User** (Firestore). Untuk `grant-admin`, gunakan akaun (boleh sama
   atau berasingan) dengan peranan **Firebase Authentication Admin**. Muat turun kunci JSON —
   **jangan commit**.
5. Deploy rules dan index (termasuk polisi TTL):
   ```sh
   pnpm exec firebase deploy --config firebase/firebase.json --project lensarent-staging \
     --only firestore:rules,firestore:indexes
   ```
   `storage:rules` ditambah apabila Cloud Storage diaktifkan (Fasa 2, perlu pelan Blaze).

### Cloudflare

1. **Turnstile**: cipta widget untuk domain environment itu. Site key → `apps/web/.env.staging`
   / `.env.production` (`VITE_TURNSTILE_SITE_KEY`). Secret key → secret Worker.
2. **Rate limiting**: `namespace_id` dalam `wrangler.toml` (1001 staging, 1002 production)
   mesti unik dalam akaun.
3. Secret Worker (tanya satu demi satu, nilai tidak pernah dipaparkan):
   ```sh
   cd apps/worker
   wrangler secret put FIREBASE_SERVICE_ACCOUNT --env staging   # tampal JSON penuh
   wrangler secret put FIREBASE_API_KEY --env staging
   wrangler secret put TURNSTILE_SECRET_KEY --env staging
   wrangler secret put PHONE_HASH_PEPPER --env staging          # openssl rand -base64 48
   ```
   ⚠️ **Jangan tukar `PHONE_HASH_PEPPER` selepas ada data**: hash lama tidak akan sepadan
   lagi. Simpan salinannya dalam pengurus kata laluan.
4. Kemas kini `FIREBASE_PROJECT_ID` dalam `[env.staging.vars]` / `[env.production.vars]`.
5. Production: tambah route domain tersuai dalam `wrangler.toml` apabila `{{DOMAIN}}` muktamad.

### Jadikan akaun admin

```sh
pnpm grant-admin --project lensarent-staging --email admin@contoh.my --key ./sa.json
```

Tarik balik (juga menamatkan sesi aktif akaun itu serta-merta):

```sh
pnpm grant-admin --project lensarent-staging --email admin@contoh.my --key ./sa.json --revoke
```

## 2. Deploy

```sh
pnpm test                                     # semuanya mesti hijau

# Staging
pnpm --filter @lensarent/web build            # mod staging: banner DRAF, noindex
cd apps/worker && wrangler deploy --env staging

# Production — build gagal selagi ada draf / kunci ujian / tiada VITE_SITE_ORIGIN
pnpm --filter @lensarent/web build:production
cd apps/worker && wrangler deploy --env production
```

Worker enggan berjalan di staging/production jika hos emulator diset atau secret
tertinggal (`500` generik; butiran dalam Workers Logs).

## 3. Semakan selepas deploy (staging dahulu)

- [ ] `GET /api/health` → `200`, `environment` betul.
- [ ] Laman `/`, `/terma`, `/privasi`, `/polisi`, `/panduan`, `/soalan-lazim` dibuka; header
      CSP hadir (`curl -I`).
- [ ] Borang minat dihantar dengan widget Turnstile sebenar → lead muncul di `/admin/`.
      **Ini juga mengesahkan pertukaran token OAuth service account sebenar dan CSP
      Turnstile — kedua-duanya tidak dapat diuji dalam sesi pembangunan.**
- [ ] Log masuk admin, tukar status, eksport CSV, log keluar.
- [ ] Kata laluan salah 6 kali → `429`.
- [ ] iOS Safari & Android Chrome: borang dan admin.

## 4. Backup (Fasa 2)

Export Firestore terurus harian (`projects.databases.exportDocuments`, perlu Blaze) ke
bucket berasingan dengan lifecycle 30 hari, dan runbook restore yang diuji ke staging.
Sehingga itu, data Fasa 1 (leads) boleh dieksport sebagai CSV dari panel admin.
