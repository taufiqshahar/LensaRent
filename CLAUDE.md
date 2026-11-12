# LensaRent — notes for Claude Code

Booking system for renting a DJI Osmo Pocket 4P (northern Peninsular Malaysia). The full
brief is `CLAUDE_CODE_MASTER_PROMPT.md`; decisions that refine or override it are in
`docs/DECISIONS.md`. Read both before changing behaviour.

**Status:** Fasa 0 (foundation) is complete. Work proceeds one phase at a time and STOPS
for the owner's approval after each phase (master prompt §3).

## Commands

| Task | Command |
|---|---|
| Install | `pnpm install` |
| Typecheck | `pnpm typecheck` |
| Lint + format check | `pnpm lint` (fix formatting: `pnpm format`) |
| Unit tests | `pnpm test:unit` |
| Emulator tests | `pnpm test:emulator` (starts and stops the emulators itself; needs Java) |
| Everything | `pnpm test` |
| Build | `pnpm build` (Vite build, then `wrangler deploy --dry-run`) |
| Local dev | `pnpm dev:emulators` in one terminal, `pnpm dev` in another |
| Deploy | `wrangler deploy --env staging` / `--env production` from `apps/worker` — always with `--env` |

Run one Worker test file: `pnpm --filter @lensarent/worker exec vitest run test/unit/logger.test.ts`.
Worker integration tests need the emulators running (`pnpm dev:emulators`).

## Layout

- `packages/shared` — pure domain logic and zod schemas. No I/O. Coverage gate 90%.
- `apps/worker` — the single Cloudflare Worker: `/api/*`, later webhook and cron.
- `apps/web` — Vite + TypeScript, no UI framework. Public site and `/admin`.
- `firebase` — Security Rules, indexes, emulator config, rules tests.
- `docs` — architecture, decisions, schema, logic, security, testing.

## Rules that must not be broken

1. **The Worker is the only enforcement layer.** It writes to Firestore as a service
   account, which bypasses Security Rules. Every invariant is checked in Worker code
   before `commit`. Firestore enforces nothing.
2. **No client talks to Firestore or Storage directly.** Rules are deny-all. Admin reads
   also go through `GET /api/admin/*`. Do not add an `allow` rule without an ADR.
3. **Anti double-booking** = one `availabilityLocks/{unitId}_{yyyy-MM-dd}` document per
   unit per day, all days created in ONE atomic commit with `exists=false`, together with
   the booking documents (`acquireDayLocks`). Releasing a lock DELETES the document. Never
   create locks one at a time, and never add an "inactive" flag.
4. **Status changes** go through `canTransition` from `@lensarent/shared`, inside a
   transaction that also writes `bookingEvents` and `auditLogs`.
5. **Ledger entries are append-only.** Create only; a correction is a reversing entry.
6. **Money is integer sen.** No floats anywhere. The Firestore codec rejects non-integers.
7. **Time is MYT (UTC+8).** Use the helpers in `packages/shared/src/time.ts`. No
   moment/dayjs, no local-time `Date` getters.
8. **Business values live in `settings/*`**, validated by `settingsSchemas`. Never
   hard-code a price, deposit, slot or policy. Do not guess a business decision — ask.
9. **No PII in logs.** Log `bookingId` / `refCode` only, through `createLogger`.
10. **No `innerHTML`** (or `outerHTML` / `insertAdjacentHTML`) in `apps/web`.
11. **Never store a MyKad image or full IC number.** Only the last 4 digits, who verified,
    and when.
12. **Secrets** live in Worker secrets / GitHub Secrets only. Nothing sensitive in the
    repo, in Firestore, or in the frontend bundle.
13. **`ABORTED` from Firestore means contention, nothing applied.** Retry it; do not treat
    it as a business answer. `commit` and `runTransaction` already retry.

## Conventions

- TypeScript strict; no `any` without a written reason. ESLint must be clean.
- Code, identifiers and comments in English. Customer-facing text in Bahasa Melayu, kept
  in `apps/web/src/strings.bm.ts` (HTML uses `{{t:key}}`, substituted at build time).
- A new dependency needs a justification in `docs/DECISIONS.md`. Prefer Web APIs.
- Do not use `firebase-admin` in the Worker — it cannot run there (ADR-001).
- Tests share one emulator: use unique ids (`uniqueId()`), never clear emulator data.
- Do not edit `firebase/*.rules` while emulators are running in a proxied sandbox; the
  hot reload can crash the emulator process there.
- After each phase: all tests green, docs and this file updated, summary to the owner,
  then stop.
