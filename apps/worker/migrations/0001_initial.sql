-- LensaRent — initial schema (Cloudflare D1 / SQLite).
--
-- Timestamps are ISO-8601 UTC strings written by the Worker ("2026-11-18T08:00:00.000Z"):
-- they sort correctly as text and read clearly in the D1 console. Calendar days are
-- "yyyy-MM-dd" in Malaysia time. Money (from Fasa 2) is INTEGER sen.
--
-- The Worker is still the main enforcement layer, but the database now backs it up:
-- primary keys, CHECK constraints and triggers reject what must never be stored.

-- ── Interest form (Fasa 1) ─────────────────────────────────────────────────────────────
CREATE TABLE leads (
  id               TEXT PRIMARY KEY CHECK (length(id) = 20),
  name             TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  phone_e164       TEXT NOT NULL CHECK (phone_e164 GLOB '+601[0-9]*'),
  phone_hash       TEXT NOT NULL,
  desired_date     TEXT CHECK (desired_date IS NULL OR desired_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  usage            TEXT NOT NULL CHECK (usage IN ('vlog', 'travel', 'event', 'content', 'family', 'other')),
  source           TEXT NOT NULL CHECK (source IN ('tiktok', 'instagram', 'facebook', 'whatsapp', 'google', 'friend', 'other')),
  status           TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'converted', 'not_interested', 'spam')),
  notes            TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 2000),
  privacy_version  TEXT NOT NULL,
  consent_at       TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
) STRICT;

-- Newest first, with or without a status filter. `id` breaks ties for stable paging.
CREATE INDEX leads_by_created ON leads (created_at DESC, id DESC);
CREATE INDEX leads_by_status_created ON leads (status, created_at DESC, id DESC);
CREATE INDEX leads_by_phone_hash ON leads (phone_hash);

-- ── Anti double-booking (docs/DECISIONS.md, ADR-002 / ADR-017) ─────────────────────────
-- One row per unit per day. The PRIMARY KEY makes a second claim on the same day
-- impossible; all days of a booking are inserted in ONE atomic batch.
CREATE TABLE availability_locks (
  unit_id          TEXT NOT NULL,
  date             TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  kind             TEXT NOT NULL CHECK (kind IN ('hold', 'booking', 'maintenance')),
  booking_id       TEXT,
  block_id         TEXT,
  hold_expires_at  TEXT,
  created_at       TEXT NOT NULL,
  PRIMARY KEY (unit_id, date),
  -- Exactly one owner: a booking (hold/booking) or a maintenance block.
  CHECK ((kind = 'maintenance' AND block_id IS NOT NULL AND booking_id IS NULL)
      OR (kind <> 'maintenance' AND booking_id IS NOT NULL AND block_id IS NULL)),
  -- Only holds expire.
  CHECK ((kind = 'hold') = (hold_expires_at IS NOT NULL))
) STRICT, WITHOUT ROWID;

CREATE INDEX availability_locks_by_booking ON availability_locks (booking_id) WHERE booking_id IS NOT NULL;

-- ── Rate limits (ADR-007) ──────────────────────────────────────────────────────────────
CREATE TABLE rate_limits (
  key         TEXT PRIMARY KEY,
  count       INTEGER NOT NULL CHECK (count >= 1),
  expires_at  TEXT NOT NULL
) STRICT, WITHOUT ROWID;

CREATE INDEX rate_limits_by_expiry ON rate_limits (expires_at);

-- ── Audit log: who changed what (field NAMES only, never values) ──────────────────────
CREATE TABLE audit_logs (
  id              TEXT PRIMARY KEY,
  actor_id        TEXT NOT NULL,
  actor_email     TEXT NOT NULL,
  action          TEXT NOT NULL,
  target_table    TEXT NOT NULL,
  target_id       TEXT NOT NULL,
  changed_fields  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(changed_fields)),
  at              TEXT NOT NULL
) STRICT;

CREATE INDEX audit_logs_by_target ON audit_logs (target_table, target_id, at);

-- Append-only, enforced by the database itself.
CREATE TRIGGER audit_logs_no_update BEFORE UPDATE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'audit_logs is append-only');
END;

CREATE TRIGGER audit_logs_no_delete BEFORE DELETE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'audit_logs is append-only');
END;
