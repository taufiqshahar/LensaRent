-- LensaRent — Fasa 2: bookings, payments, ledger, operations.
--
-- Same conventions as 0001: ISO-8601 UTC text timestamps, yyyy-MM-dd MYT calendar days,
-- money as INTEGER sen (CHECKed), append-only tables guarded by triggers. The Worker
-- validates everything first; these constraints are the second line.

-- ── Settings (admin-editable keys only; the rest come from code, ADR-020) ──────────────
CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL CHECK (json_valid(value)),
  updated_by  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
) STRICT, WITHOUT ROWID;

-- ── Units ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE units (
  id             TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 40 AND id NOT GLOB '*[^A-Za-z0-9-]*'),
  name           TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  model          TEXT NOT NULL,
  serial_number  TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL CHECK (status IN ('active', 'maintenance', 'retired')),
  accessories    TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(accessories)),
  sort_order     INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
) STRICT;

-- ── Customers: one per phone number, enforced by the database ─────────────────────────
CREATE TABLE customers (
  id               TEXT PRIMARY KEY,
  phone_hash       TEXT NOT NULL UNIQUE,
  name             TEXT NOT NULL,
  phone_e164       TEXT NOT NULL CHECK (phone_e164 GLOB '+601[0-9]*'),
  email            TEXT NOT NULL,
  tier             TEXT NOT NULL DEFAULT 'new' CHECK (tier IN ('new', 'verified', 'returning')),
  completed_count  INTEGER NOT NULL DEFAULT 0 CHECK (completed_count >= 0),
  blocked          INTEGER NOT NULL DEFAULT 0 CHECK (blocked IN (0, 1)),
  notes            TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 2000),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
) STRICT;

-- ── Bookings ───────────────────────────────────────────────────────────────────────────
CREATE TABLE bookings (
  id                   TEXT PRIMARY KEY,
  ref_code             TEXT NOT NULL UNIQUE,
  lookup_token_hash    TEXT NOT NULL,
  unit_id              TEXT NOT NULL REFERENCES units (id),
  customer_id          TEXT NOT NULL REFERENCES customers (id),
  -- Snapshot at booking time; the customer record may change later.
  customer_name        TEXT NOT NULL,
  customer_phone_e164  TEXT NOT NULL,
  customer_email       TEXT NOT NULL,
  pickup_slot_id       TEXT NOT NULL,
  pickup_at            TEXT NOT NULL,
  pickup_location_id   TEXT NOT NULL,
  return_slot_id       TEXT NOT NULL,
  return_at            TEXT NOT NULL,
  return_slot_end      TEXT NOT NULL,
  return_location_id   TEXT NOT NULL,
  locked_dates         TEXT NOT NULL CHECK (json_valid(locked_dates)),
  rental_days          INTEGER NOT NULL CHECK (rental_days >= 1),
  add_ons              TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(add_ons)),
  rental_sen           INTEGER NOT NULL CHECK (typeof(rental_sen) = 'integer' AND rental_sen >= 0),
  add_ons_sen          INTEGER NOT NULL CHECK (typeof(add_ons_sen) = 'integer' AND add_ons_sen >= 0),
  meetup_sen           INTEGER NOT NULL CHECK (typeof(meetup_sen) = 'integer' AND meetup_sen >= 0),
  discount_sen         INTEGER NOT NULL CHECK (typeof(discount_sen) = 'integer' AND discount_sen >= 0),
  deposit_sen          INTEGER NOT NULL CHECK (typeof(deposit_sen) = 'integer' AND deposit_sen >= 0),
  total_payable_sen    INTEGER NOT NULL CHECK (typeof(total_payable_sen) = 'integer'
                         AND total_payable_sen = rental_sen + add_ons_sen + meetup_sen - discount_sen + deposit_sen),
  status               TEXT NOT NULL CHECK (status IN ('pending_payment', 'confirmed', 'ready_for_pickup',
                         'active_rental', 'overdue', 'return_inspection', 'disputed', 'refund_pending',
                         'completed', 'refunded', 'cancelled')),
  status_reason        TEXT,
  -- Written by every status change; later statements in the same batch check it, so they
  -- only take effect if the status change itself did (rule 14 in CLAUDE.md).
  last_transition_id   TEXT NOT NULL,
  hold_expires_at      TEXT,
  terms_version        TEXT NOT NULL,
  privacy_version      TEXT NOT NULL,
  consent_at           TEXT NOT NULL,
  consent_ip_hash      TEXT NOT NULL,
  -- Identity check at handover: last four digits only. Never a full IC, never an image.
  id_last4             TEXT CHECK (id_last4 IS NULL OR (length(id_last4) = 4 AND id_last4 NOT GLOB '*[^0-9]*')),
  verified_by          TEXT,
  verified_at          TEXT,
  handover             TEXT CHECK (handover IS NULL OR json_valid(handover)),
  return_inspection    TEXT CHECK (return_inspection IS NULL OR json_valid(return_inspection)),
  returned_at          TEXT,
  receipt_no           TEXT UNIQUE,
  reschedule_used      INTEGER NOT NULL DEFAULT 0 CHECK (reschedule_used IN (0, 1)),
  notes                TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 2000),
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  CHECK ((status = 'pending_payment') = (hold_expires_at IS NOT NULL)),
  CHECK (return_at > pickup_at AND return_slot_end > return_at)
) STRICT;

CREATE INDEX bookings_by_status ON bookings (status, pickup_at);
CREATE INDEX bookings_by_pickup ON bookings (pickup_at);
CREATE INDEX bookings_by_return ON bookings (return_slot_end);
CREATE INDEX bookings_by_customer ON bookings (customer_id, created_at);
CREATE INDEX bookings_by_hold_expiry ON bookings (hold_expires_at) WHERE hold_expires_at IS NOT NULL;

CREATE TABLE booking_events (
  id           TEXT PRIMARY KEY,
  booking_id   TEXT NOT NULL REFERENCES bookings (id),
  from_status  TEXT,
  to_status    TEXT NOT NULL,
  actor_id     TEXT NOT NULL,
  actor_type   TEXT NOT NULL CHECK (actor_type IN ('system', 'admin', 'webhook')),
  reason       TEXT,
  at           TEXT NOT NULL
) STRICT;

CREATE INDEX booking_events_by_booking ON booking_events (booking_id, at);

CREATE TRIGGER booking_events_no_update BEFORE UPDATE ON booking_events
BEGIN SELECT RAISE(ABORT, 'booking_events is append-only'); END;
CREATE TRIGGER booking_events_no_delete BEFORE DELETE ON booking_events
BEGIN SELECT RAISE(ABORT, 'booking_events is append-only'); END;

-- ── Payments ───────────────────────────────────────────────────────────────────────────
CREATE TABLE payments (
  id             TEXT PRIMARY KEY,
  booking_id     TEXT NOT NULL REFERENCES bookings (id),
  provider       TEXT NOT NULL CHECK (provider IN ('chip')),
  provider_ref   TEXT NOT NULL UNIQUE,
  expected_sen   INTEGER NOT NULL CHECK (typeof(expected_sen) = 'integer' AND expected_sen > 0),
  paid_sen       INTEGER CHECK (paid_sen IS NULL OR typeof(paid_sen) = 'integer'),
  fee_sen        INTEGER CHECK (fee_sen IS NULL OR typeof(fee_sen) = 'integer'),
  currency       TEXT NOT NULL DEFAULT 'MYR' CHECK (currency = 'MYR'),
  status         TEXT NOT NULL CHECK (status IN ('created', 'paid', 'mismatch', 'cancelled')),
  raw_status     TEXT,
  is_test        INTEGER NOT NULL CHECK (is_test IN (0, 1)),
  checkout_url   TEXT NOT NULL,
  paid_at        TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
) STRICT;

CREATE INDEX payments_by_booking ON payments (booking_id);

-- ── Ledger: append-only, signed, integer sen ──────────────────────────────────────────
-- Income-like entries are positive, outgoing ones negative. A correction is a reversal:
-- an entry of the same type and opposite sign that names the entry it reverses.
CREATE TABLE ledger_entries (
  id           TEXT PRIMARY KEY,
  booking_id   TEXT NOT NULL REFERENCES bookings (id),
  type         TEXT NOT NULL CHECK (type IN ('RENTAL', 'ADD_ON', 'MEETUP_FEE', 'DISCOUNT', 'DEPOSIT_IN',
                 'DEPOSIT_REFUND', 'DEPOSIT_DEDUCTION', 'LATE_FEE', 'DAMAGE_CHARGE', 'CANCELLATION_FEE',
                 'REFUND', 'GATEWAY_FEE')),
  amount_sen   INTEGER NOT NULL CHECK (typeof(amount_sen) = 'integer' AND amount_sen <> 0),
  method       TEXT NOT NULL CHECK (method IN ('gateway', 'duitnow', 'cash', 'deposit')),
  reference    TEXT NOT NULL DEFAULT '',
  note         TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  reverses_id  TEXT UNIQUE REFERENCES ledger_entries (id),
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  CHECK (
    (reverses_id IS NULL) = (
      (type IN ('RENTAL', 'ADD_ON', 'MEETUP_FEE', 'DEPOSIT_IN', 'LATE_FEE', 'DAMAGE_CHARGE', 'CANCELLATION_FEE')
        AND amount_sen > 0)
      OR (type IN ('DISCOUNT', 'DEPOSIT_REFUND', 'DEPOSIT_DEDUCTION', 'REFUND', 'GATEWAY_FEE')
        AND amount_sen < 0)
    )
  )
) STRICT;

CREATE INDEX ledger_entries_by_booking ON ledger_entries (booking_id, created_at);

CREATE TRIGGER ledger_entries_no_update BEFORE UPDATE ON ledger_entries
BEGIN SELECT RAISE(ABORT, 'ledger_entries is append-only'); END;
CREATE TRIGGER ledger_entries_no_delete BEFORE DELETE ON ledger_entries
BEGIN SELECT RAISE(ABORT, 'ledger_entries is append-only'); END;

-- ── Webhook idempotency: a second insert of the same event fails ──────────────────────
CREATE TABLE webhook_events (
  provider     TEXT NOT NULL,
  event_key    TEXT NOT NULL,
  received_at  TEXT NOT NULL,
  result       TEXT NOT NULL,
  PRIMARY KEY (provider, event_key)
) STRICT, WITHOUT ROWID;

-- ── Email outbox ───────────────────────────────────────────────────────────────────────
CREATE TABLE notifications_outbox (
  id          TEXT PRIMARY KEY,
  channel     TEXT NOT NULL CHECK (channel IN ('email')),
  template    TEXT NOT NULL,
  to_address  TEXT NOT NULL,
  payload     TEXT NOT NULL CHECK (json_valid(payload)),
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts    INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error  TEXT,
  send_after  TEXT NOT NULL,
  sent_at     TEXT,
  -- Same key twice = same message: reminders and alerts are queued once.
  dedupe_key  TEXT UNIQUE,
  created_at  TEXT NOT NULL
) STRICT;

CREATE INDEX outbox_due ON notifications_outbox (status, send_after);

-- ── Receipt numbers: R-YYYY-00001, sequential per year ────────────────────────────────
CREATE TABLE receipt_counters (
  year         TEXT PRIMARY KEY,
  last_number  INTEGER NOT NULL CHECK (last_number >= 1)
) STRICT, WITHOUT ROWID;

-- ── Maintenance blocks (their days are availability_locks of kind 'maintenance') ──────
CREATE TABLE maintenance_blocks (
  id          TEXT PRIMARY KEY,
  unit_id     TEXT NOT NULL REFERENCES units (id),
  from_date   TEXT NOT NULL,
  to_date     TEXT NOT NULL,
  reason      TEXT NOT NULL DEFAULT '' CHECK (length(reason) <= 200),
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  CHECK (to_date >= from_date)
) STRICT;

-- ── Handover photos (objects in R2; deleted after the retention period) ───────────────
CREATE TABLE handover_photos (
  id            TEXT PRIMARY KEY,
  booking_id    TEXT NOT NULL REFERENCES bookings (id),
  stage         TEXT NOT NULL CHECK (stage IN ('checkout', 'return')),
  r2_key        TEXT NOT NULL UNIQUE,
  content_type  TEXT NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  size_bytes    INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 8388608),
  uploaded_by   TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  deleted_at    TEXT
) STRICT;

CREATE INDEX handover_photos_by_booking ON handover_photos (booking_id, stage);
