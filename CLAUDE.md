# LensaRent — notes for Claude Code

Booking system for renting a DJI Osmo Pocket 4P (northern Peninsular Malaysia). The full
brief is `CLAUDE_CODE_MASTER_PROMPT.md`; decisions that refine or override it are in
`docs/DECISIONS.md`. Read both before changing behaviour.

**Status:** Fasa 0 (foundation) and Fasa 1 (landing page, interest form, admin leads) are
complete but not yet deployed. **Stack: Cloudflare only** — Workers, D1 (data), Access
(admin sign-in), Turnstile. Firebase was removed on 18 Nov 2026 (ADR-017/018); the master
prompt's Firebase sections are superseded. Work proceeds one phase at a time and STOPS
for the owner's approval after each phase (master prompt §3).

## Commands

| Task                | Command                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------ |
| Install             | `pnpm install`                                                                             |
| Typecheck           | `pnpm typecheck`                                                                           |
| Lint + format check | `pnpm lint` (fix formatting: `pnpm format`)                                                |
| All tests           | `pnpm test` (Worker tests run in workerd against a local D1; nothing else to install)      |
| Build               | `pnpm build` (Vite **staging** build, then `wrangler deploy --dry-run`)                    |
| Production site     | `pnpm --filter @lensarent/web build:production` — refuses while drafts/test keys remain    |
| Local dev           | `cp apps/worker/.dev.vars.example apps/worker/.dev.vars`, then `pnpm dev`                  |
| Schema change       | New file `apps/worker/migrations/000N_name.sql` (never edit an applied one)                |
| Deploy              | `wrangler d1 migrations apply DB --env <env> --remote`, then `wrangler deploy --env <env>` |

Run one Worker test file: `pnpm --filter @lensarent/worker exec vitest run test/unit/logger.test.ts`.
Locally the admin is `ACCESS_DEV_EMAIL` (wrangler.toml); deployed, it is Cloudflare Access.

## Layout

- `packages/shared` — pure domain logic and zod schemas. No I/O. Coverage gate 90%.
- `apps/worker` — the single Cloudflare Worker: `/api/*`, D1 migrations, later webhook and cron.
- `apps/web` — Vite + TypeScript, no UI framework. Pages are TypeScript functions in
  `src/pages` rendered to static HTML at build time; `src/main.ts` / `src/admin.ts` are the
  only browser scripts.
- `docs` — architecture, decisions, schema, logic, security, testing.

## Rules that must not be broken

1. **The Worker enforces every invariant before writing.** D1 constraints (keys, CHECK,
   triggers) are a second line, never the only one. Add the matching constraint to the
   schema when you add a rule in code.
2. **No client talks to the database.** Everything goes through `/api/*`.
3. **Admin = Cloudflare Access + Worker check.** Every `/api/admin/*` handler starts with
   `requireAdmin(context, { mutating })`, which verifies the Access JWT and `ADMIN_EMAILS`.
   Never trust Access configuration alone.
4. **Anti double-booking** = one `availability_locks` row per unit per day, PRIMARY KEY
   `(unit_id, date)`, all days inserted in ONE `db.batch` together with the booking rows
   (`acquireDayLocks`). Releasing a lock DELETES the row. Never insert locks one at a time,
   never use `INSERT OR IGNORE` / `ON CONFLICT DO NOTHING` for locks, never add an
   "inactive" flag.
5. **Status changes** go through `canTransition` from `@lensarent/shared`, in one batch with
   the `booking_events` and `audit_logs` rows.
6. **Ledger entries are append-only.** Create only; a correction is a reversing entry. The
   table gets UPDATE/DELETE-blocking triggers like `audit_logs`.
7. **Money is integer sen.** No floats anywhere; money columns get `CHECK (typeof(x) = 'integer')`.
8. **Time is MYT (UTC+8).** Use the helpers in `packages/shared/src/time.ts`. No
   moment/dayjs, no local-time `Date` getters.
9. **Business values live in `settings/*`**, validated by `settingsSchemas`. Never
   hard-code a price, deposit, slot or policy. Do not guess a business decision — ask.
10. **No PII in logs.** Log `bookingId` / `refCode` only, through `createLogger`.
11. **No `innerHTML`** (or `outerHTML` / `insertAdjacentHTML`) in `apps/web`.
12. **Never store a MyKad image or full IC number.** Only the last 4 digits, who verified,
    and when.
13. **Secrets** live in Worker secrets / GitHub Secrets only. Nothing sensitive in the
    repo, in the database, or in the frontend bundle.
14. **A batch is one transaction, but an UPDATE/DELETE matching no rows is not a failure.**
    Guard statements that must only happen together in SQL (e.g. `INSERT … WHERE EXISTS`),
    and check `meta.changes`.

## Conventions

- TypeScript strict; no `any` without a written reason. ESLint must be clean.
- Code, identifiers and comments in English. Customer-facing text in Bahasa Melayu: page
  content in `apps/web/src/content/site.ts`, enum labels in `packages/shared/src/leadOptions.ts`,
  API messages in `apps/worker/src/lib/http.ts` and the route files.
- Every number on the site (prices, deposit, fees, hours) comes from `content/facts.ts`,
  which reads the settings. Never type a price into page text.
- Anything not confirmed by the owner goes through `draft()`; never remove a `draft()` to
  make the production build pass — get the owner's confirmation.
- Build-time code imports shared via `src/render/shared.ts` (relative path); browser code
  imports `@lensarent/shared/<module>`. Browser code must not import modules that pull in
  zod (keep labels in `leadOptions.ts`).
- Admin endpoints start with `requireAdmin(context, { mutating })`; mutating ones need the
  same-origin check it performs. Every admin change writes `auditWrite()` in the same commit.
- Identifiers that become document ids (IP, phone, email) are always hashed first.
- A new dependency needs a justification in `docs/DECISIONS.md`. Prefer Web APIs.
- SQL always uses bound parameters. Dynamic conditions are built only from values that
  zod has already validated.
- Times are stored as ISO-8601 UTC strings from `services.now()`; calendar days as
  `yyyy-MM-dd` (MYT).
- Tests share one local D1 database: use unique ids (`uniqueId()`) and never clear tables.
- Test fixtures must not look like real credentials: build PEM blocks with `fakePem()`
  and keep fake tokens short and low-entropy. `.gitleaksignore` is only for findings
  confirmed to be fake.
- After each phase: all tests green, docs and this file updated, summary to the owner,
  then stop.
