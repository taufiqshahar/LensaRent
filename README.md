# LensaRent

Sistem tempahan sewaan DJI Osmo Pocket 4P — Parit Buntar, Bandar Baharu, Nibong Tebal.

**Stack:** Cloudflare Worker (API + aset statik) · Firebase Firestore, Auth, Storage ·
Vite + TypeScript · pnpm workspaces.

**Status:** Fasa 0 dan Fasa 1 siap, belum dideploy. Laman awam (BM), borang minat dan panel
admin leads ada; aliran tempahan dan bayaran ialah Fasa 2.

| Fasa | Kandungan                                                            | Status            |
| ---- | -------------------------------------------------------------------- | ----------------- |
| 0    | Monorepo, logik domain, klien Firestore, kunci slot, rules, CI, docs | ✅                |
| 1    | Landing page, polisi, borang minat, log masuk admin, admin leads     | ✅ belum dideploy |
| 2    | Tempahan, bayaran CHIP, operasi admin, email, cron, backup           | —                 |
| 3    | Laporan, referral, retention                                         | —                 |

## Setup lokal

Perlu: **Node 22.13+**, **pnpm 10**, **Java 21** (untuk Firebase emulator).

```sh
# 1. Pasang dependency
pnpm install

# 2. Jalankan semua ujian (emulator dihidupkan dan dimatikan secara automatik)
pnpm test

# 3. Sediakan rahsia dev lokal (menghala ke emulator; tiada kelayakan sebenar)
cp apps/worker/.dev.vars.example apps/worker/.dev.vars

# 4. Hidupkan emulator Firebase (terminal 1)
pnpm dev:emulators

# 5. Bina laman dan hidupkan Worker (terminal 2)
pnpm dev

# 6. Semak
curl http://localhost:8787/api/health

# 7. (Pilihan) Jadikan akaun emulator sebagai admin, kemudian buka /admin/
curl -s -X POST "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-api-key" \
  -H 'content-type: application/json' -d '{"email":"admin@contoh.my","password":"kata-laluan-panjang"}'
FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 \
  pnpm grant-admin --project demo-lensarent --email admin@contoh.my
```

Laman: <http://localhost:8787/>.

## Arahan

| Arahan               | Fungsi                                                    |
| -------------------- | --------------------------------------------------------- |
| `pnpm typecheck`     | TypeScript strict, semua pakej                            |
| `pnpm lint`          | ESLint + semakan format (`pnpm format` untuk membetulkan) |
| `pnpm test:unit`     | Logik domain (gate coverage 90%) + unit Worker            |
| `pnpm test:emulator` | Security Rules + integrasi Worker terhadap emulator       |
| `pnpm test`          | Semua ujian                                               |
| `pnpm build`         | Build Vite (staging) + dry-run bundle Worker              |
| `pnpm grant-admin`   | Beri / tarik balik akses admin                            |

## Struktur

```
packages/shared   Logik domain pure + skema zod (harga, tempoh, state machine, …)
apps/worker       Cloudflare Worker: /api/*, klien Firestore REST, kunci slot
apps/web          Laman statik Vite (awam + /admin), dijana pada masa build
scripts           grant-admin.ts
firebase          Security Rules, index, konfigurasi emulator, ujian rules
docs              Dokumentasi
```

## Deploy

Belum dideploy: perlukan projek Firebase, akaun Cloudflare, kunci Turnstile dan domain.
Langkah penuh dalam [docs/DEPLOYMENT_AND_BACKUP.md](docs/DEPLOYMENT_AND_BACKUP.md).
**Sentiasa nyatakan environment** (`wrangler deploy --env staging|production`). Build laman
production menolak untuk berjalan selagi ada kandungan draf.

## Dokumentasi

| Dokumen                                                                            | Kandungan                                                  |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| [CLAUDE_CODE_MASTER_PROMPT.md](CLAUDE_CODE_MASTER_PROMPT.md)                       | Spesifikasi asal                                           |
| [docs/DECISIONS.md](docs/DECISIONS.md)                                             | Keputusan seni bina, bukti, dan perkara menunggu kelulusan |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)                                       | Bentuk sistem                                              |
| [docs/BOOKING_AND_INVENTORY_LOGIC.md](docs/BOOKING_AND_INVENTORY_LOGIC.md)         | Harga, tempoh, kunci slot, state machine                   |
| [docs/API_SPECIFICATION.md](docs/API_SPECIFICATION.md)                             | Endpoint, permintaan, respons, kod ralat                   |
| [docs/DEPLOYMENT_AND_BACKUP.md](docs/DEPLOYMENT_AND_BACKUP.md)                     | Persediaan akaun, rahsia, deploy, semakan selepas deploy   |
| [docs/DATABASE_SCHEMA.md](docs/DATABASE_SCHEMA.md)                                 | Koleksi Firestore                                          |
| [docs/SECURITY_AND_PRIVACY.md](docs/SECURITY_AND_PRIVACY.md)                       | Model keselamatan dan privasi                              |
| [docs/TESTING_AND_ACCEPTANCE_CRITERIA.md](docs/TESTING_AND_ACCEPTANCE_CRITERIA.md) | Apa yang diuji dan cara menjalankannya                     |
| [CLAUDE.md](CLAUDE.md)                                                             | Konvensyen dan peraturan untuk Claude Code                 |

Dokumen yang tiba pada Fasa 2: `PAYMENT_AND_DEPOSIT_SPEC`, `RUNBOOK_MANUAL_FALLBACK`.

## Peraturan yang tidak boleh dilanggar

1. Worker ialah satu-satunya lapisan penguatkuasaan; Firestore tidak mengesahkan apa-apa.
2. Tiada client menyentuh Firestore atau Storage secara terus.
3. Wang ialah integer sen. Masa ialah MYT.
4. Nilai bisnes berada dalam `settings/*`, bukan dalam kod.
5. Tiada PII dalam log. Tiada imej MyKad atau nombor IC penuh dalam sistem.
6. Rahsia hanya dalam Worker secrets / GitHub Secrets.
