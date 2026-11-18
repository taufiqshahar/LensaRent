# LensaRent

Sistem tempahan sewaan DJI Osmo Pocket 4P — Parit Buntar, Bandar Baharu, Nibong Tebal.

**Stack:** satu akaun Cloudflare — Workers (API + aset statik), **D1** (pangkalan data),
**Access** (log masuk admin), Turnstile (anti-bot). Vite + TypeScript, pnpm workspaces.

**Status:** Fasa 0 dan Fasa 1 siap, belum dideploy.

| Fasa | Kandungan                                                        | Status            |
| ---- | ---------------------------------------------------------------- | ----------------- |
| 0    | Monorepo, logik domain, kunci slot anti double-booking, CI, docs | ✅                |
| 1    | Landing page, polisi, borang minat, admin leads                  | ✅ belum dideploy |
| 2    | Tempahan, bayaran CHIP, operasi admin, email, cron, backup       | —                 |
| 3    | Laporan, referral, retention                                     | —                 |

## Setup lokal

Perlu: **Node 22.13+** dan **pnpm 10**. Itu sahaja — tiada Java, emulator atau akaun.

```sh
# 1. Pasang dependency
pnpm install

# 2. Jalankan semua ujian (termasuk D1 tempatan)
pnpm test

# 3. Sediakan rahsia dev lokal (kunci ujian Turnstile; bukan rahsia sebenar)
cp apps/worker/.dev.vars.example apps/worker/.dev.vars

# 4. Bina laman, sediakan D1 tempatan, hidupkan Worker
pnpm dev

# 5. Buka http://localhost:8787/ dan http://localhost:8787/admin/
```

Secara tempatan, admin ialah `ACCESS_DEV_EMAIL` dalam `apps/worker/wrangler.toml`, kerana
tiada Cloudflare Access di hadapan `wrangler dev`.

## Arahan

| Arahan           | Fungsi                                                      |
| ---------------- | ----------------------------------------------------------- |
| `pnpm typecheck` | TypeScript strict, semua pakej                              |
| `pnpm lint`      | ESLint + semakan format (`pnpm format` untuk membetulkan)   |
| `pnpm test`      | Logik domain (gate coverage 90%), render laman, Worker + D1 |
| `pnpm build`     | Build Vite (staging) + dry-run bundle Worker                |
| `pnpm dev`       | Laman + D1 tempatan + Worker di `localhost:8787`            |

## Struktur

```
packages/shared   Logik domain pure + skema zod (harga, tempoh, state machine, …)
apps/worker       Cloudflare Worker: /api/*, migrasi D1, kunci slot, pengesahan Access
apps/web          Laman statik Vite (awam + /admin), dijana pada masa build
docs              Dokumentasi
```

## Deploy

Belum dideploy: perlukan akaun Cloudflare, domain dan kunci Turnstile. Langkah penuh
(D1, Access, secret, semakan selepas deploy) dalam
[docs/DEPLOYMENT_AND_BACKUP.md](docs/DEPLOYMENT_AND_BACKUP.md). **Sentiasa nyatakan
environment** (`wrangler deploy --env staging|production`). Build laman production menolak
untuk berjalan selagi ada kandungan draf.

## Dokumentasi

| Dokumen                                                                            | Kandungan                                                      |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| [CLAUDE_CODE_MASTER_PROMPT.md](CLAUDE_CODE_MASTER_PROMPT.md)                       | Spesifikasi asal (stack Firebase; digantikan oleh ADR-017/018) |
| [docs/DECISIONS.md](docs/DECISIONS.md)                                             | Keputusan seni bina, bukti, dan perkara menunggu kelulusan     |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)                                       | Bentuk sistem                                                  |
| [docs/BOOKING_AND_INVENTORY_LOGIC.md](docs/BOOKING_AND_INVENTORY_LOGIC.md)         | Harga, tempoh, kunci slot, state machine                       |
| [docs/API_SPECIFICATION.md](docs/API_SPECIFICATION.md)                             | Endpoint, permintaan, respons, kod ralat                       |
| [docs/DATABASE_SCHEMA.md](docs/DATABASE_SCHEMA.md)                                 | Jadual D1                                                      |
| [docs/DEPLOYMENT_AND_BACKUP.md](docs/DEPLOYMENT_AND_BACKUP.md)                     | Persediaan Cloudflare, deploy, backup                          |
| [docs/SECURITY_AND_PRIVACY.md](docs/SECURITY_AND_PRIVACY.md)                       | Model keselamatan dan privasi                                  |
| [docs/TESTING_AND_ACCEPTANCE_CRITERIA.md](docs/TESTING_AND_ACCEPTANCE_CRITERIA.md) | Apa yang diuji dan cara menjalankannya                         |
| [CLAUDE.md](CLAUDE.md)                                                             | Konvensyen dan peraturan untuk Claude Code                     |

## Peraturan yang tidak boleh dilanggar

1. Worker menguatkuasakan setiap peraturan sebelum menulis; D1 menyokong dari belakang.
2. Tiada client menyentuh pangkalan data secara terus.
3. Wang ialah integer sen. Masa ialah MYT.
4. Nilai bisnes berada dalam `settings`, bukan dalam kod.
5. Tiada PII dalam log. Tiada imej MyKad atau nombor IC penuh dalam sistem.
6. Rahsia hanya dalam Worker secrets / GitHub Secrets.
