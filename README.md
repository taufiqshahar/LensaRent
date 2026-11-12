# LensaRent

Sistem tempahan sewaan DJI Osmo Pocket 4P — Parit Buntar, Bandar Baharu, Nibong Tebal.

**Stack:** Cloudflare Worker (API + aset statik) · Firebase Firestore, Auth, Storage ·
Vite + TypeScript · pnpm workspaces.

**Status:** Fasa 0 (asas) siap. Belum ada UI awam atau aliran tempahan.

| Fasa | Kandungan                                                            | Status                |
| ---- | -------------------------------------------------------------------- | --------------------- |
| 0    | Monorepo, logik domain, klien Firestore, kunci slot, rules, CI, docs | ✅                    |
| 1    | Landing page, borang minat, admin leads                              | ⏳ menunggu kelulusan |
| 2    | Tempahan, bayaran CHIP, operasi admin, email, cron, backup           | —                     |
| 3    | Laporan, referral, retention                                         | —                     |

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
| `pnpm build`         | Build Vite + dry-run bundle Worker                        |

## Struktur

```
packages/shared   Logik domain pure + skema zod (harga, tempoh, state machine, …)
apps/worker       Cloudflare Worker: /api/*, klien Firestore REST, kunci slot
apps/web          Laman statik Vite (awam + /admin)
firebase          Security Rules, index, konfigurasi emulator, ujian rules
docs              Dokumentasi
```

## Deploy

Belum dikonfigurasi untuk projek sebenar (ID projek Firebase dalam `wrangler.toml` masih
placeholder). Apabila tiba masanya, **sentiasa nyatakan environment**:

```sh
cd apps/worker
wrangler secret put FIREBASE_SERVICE_ACCOUNT --env staging
wrangler deploy --env staging
```

Runbook deploy dan backup penuh ditulis pada Fasa 1–2.

## Dokumentasi

| Dokumen                                                                            | Kandungan                                                  |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| [CLAUDE_CODE_MASTER_PROMPT.md](CLAUDE_CODE_MASTER_PROMPT.md)                       | Spesifikasi asal                                           |
| [docs/DECISIONS.md](docs/DECISIONS.md)                                             | Keputusan seni bina, bukti, dan perkara menunggu kelulusan |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)                                       | Bentuk sistem                                              |
| [docs/BOOKING_AND_INVENTORY_LOGIC.md](docs/BOOKING_AND_INVENTORY_LOGIC.md)         | Harga, tempoh, kunci slot, state machine                   |
| [docs/DATABASE_SCHEMA.md](docs/DATABASE_SCHEMA.md)                                 | Koleksi Firestore                                          |
| [docs/SECURITY_AND_PRIVACY.md](docs/SECURITY_AND_PRIVACY.md)                       | Model keselamatan dan privasi                              |
| [docs/TESTING_AND_ACCEPTANCE_CRITERIA.md](docs/TESTING_AND_ACCEPTANCE_CRITERIA.md) | Apa yang diuji dan cara menjalankannya                     |
| [CLAUDE.md](CLAUDE.md)                                                             | Konvensyen dan peraturan untuk Claude Code                 |

Dokumen yang tiba pada fasa kemudian: `API_SPECIFICATION`, `PAYMENT_AND_DEPOSIT_SPEC`,
`DEPLOYMENT_AND_BACKUP`, `RUNBOOK_MANUAL_FALLBACK`.

## Peraturan yang tidak boleh dilanggar

1. Worker ialah satu-satunya lapisan penguatkuasaan; Firestore tidak mengesahkan apa-apa.
2. Tiada client menyentuh Firestore atau Storage secara terus.
3. Wang ialah integer sen. Masa ialah MYT.
4. Nilai bisnes berada dalam `settings/*`, bukan dalam kod.
5. Tiada PII dalam log. Tiada imej MyKad atau nombor IC penuh dalam sistem.
6. Rahsia hanya dalam Worker secrets / GitHub Secrets.
