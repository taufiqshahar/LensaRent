import type { ActorType, BookingStatus, LedgerEntryType } from "@lensarent/shared";
import { canTransition, hasLedgerSign } from "@lensarent/shared";
import { newId } from "./db";

/**
 * Booking status changes (master prompt §7).
 *
 * Every change is one D1 batch whose FIRST statement moves the booking from the status
 * the caller read to the new one and stamps a fresh `last_transition_id`. Every other
 * statement in the batch (event, audit, locks, ledger, outbox) carries the guard
 * `EXISTS (… WHERE id = ? AND last_transition_id = ?)`. If someone else changed the
 * booking first, the UPDATE matches nothing, the guarded statements do nothing, and the
 * caller gets `StaleBookingError` — no half-applied change is possible.
 */
export interface BookingRow {
  id: string;
  ref_code: string;
  lookup_token_hash: string;
  unit_id: string;
  customer_id: string;
  customer_name: string;
  customer_phone_e164: string;
  customer_email: string;
  pickup_slot_id: string;
  pickup_at: string;
  pickup_location_id: string;
  return_slot_id: string;
  return_at: string;
  return_slot_end: string;
  return_location_id: string;
  locked_dates: string;
  rental_days: number;
  add_ons: string;
  rental_sen: number;
  add_ons_sen: number;
  meetup_sen: number;
  discount_sen: number;
  deposit_sen: number;
  total_payable_sen: number;
  status: BookingStatus;
  status_reason: string | null;
  last_transition_id: string;
  hold_expires_at: string | null;
  id_last4: string | null;
  verified_by: string | null;
  verified_at: string | null;
  handover: string | null;
  return_inspection: string | null;
  returned_at: string | null;
  receipt_no: string | null;
  reschedule_used: number;
  notes: string;
  created_at: string;
  updated_at: string;
}

export async function getBooking(db: D1Database, id: string): Promise<BookingRow | null> {
  return db.prepare("SELECT * FROM bookings WHERE id = ?").bind(id).first<BookingRow>();
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: BookingStatus,
    readonly to: BookingStatus,
  ) {
    super(`Transition ${from} → ${to} is not allowed`);
    this.name = "InvalidTransitionError";
  }
}

export class StaleBookingError extends Error {
  constructor() {
    super("The booking changed before this update was applied");
    this.name = "StaleBookingError";
  }
}

export interface Actor {
  type: ActorType;
  /** Admin id from Access, or a fixed system id such as `system:cron`. */
  id: string;
  email?: string | undefined;
}

/** SQL fragment + parameters that are true only if this transition was applied. */
export interface Guard {
  sql: string;
  params: readonly string[];
}

export interface TransitionSpec {
  to: BookingStatus;
  actor: Actor;
  reason?: string | undefined;
  /** Extra columns to set on the booking, from trusted code only. */
  set?: Readonly<Record<string, string | number | null>>;
  now: Date;
}

const SETTABLE_COLUMNS = new Set([
  "hold_expires_at",
  "id_last4",
  "verified_by",
  "verified_at",
  "handover",
  "return_inspection",
  "returned_at",
  "reschedule_used",
]);

export interface PreparedTransition {
  statements: D1PreparedStatement[];
  guard: Guard;
}

/**
 * Builds the statements for `booking.status → spec.to`. Throws `InvalidTransitionError`
 * if the state machine forbids it for this actor. `extra` receives the guard and returns
 * statements that must only apply together with the transition.
 */
export function prepareTransition(
  db: D1Database,
  booking: Pick<BookingRow, "id" | "status">,
  spec: TransitionSpec,
  extra: (guard: Guard) => D1PreparedStatement[] = () => [],
): PreparedTransition {
  if (!canTransition(booking.status, spec.to, spec.actor.type)) {
    throw new InvalidTransitionError(booking.status, spec.to);
  }
  const transitionId = newId();
  const at = spec.now.toISOString();
  const guard: Guard = {
    sql: "EXISTS (SELECT 1 FROM bookings WHERE id = ? AND last_transition_id = ?)",
    params: [booking.id, transitionId],
  };

  const sets = Object.entries(spec.set ?? {});
  for (const [column] of sets) {
    if (!SETTABLE_COLUMNS.has(column)) throw new Error(`Column ${column} cannot be set here`);
  }
  // Leaving pending_payment always clears the hold expiry (a CHECK requires it).
  const clearsHold =
    booking.status === "pending_payment" && !sets.some(([c]) => c === "hold_expires_at");
  const assignments = [
    "status = ?",
    "status_reason = ?",
    "last_transition_id = ?",
    "updated_at = ?",
    ...(clearsHold ? ["hold_expires_at = NULL"] : []),
    ...sets.map(([column]) => `${column} = ?`),
  ];

  const statements = [
    db
      .prepare(`UPDATE bookings SET ${assignments.join(", ")} WHERE id = ? AND status = ?`)
      .bind(
        spec.to,
        spec.reason ?? null,
        transitionId,
        at,
        ...sets.map(([, value]) => value),
        booking.id,
        booking.status,
      ),
    db
      .prepare(
        `INSERT INTO booking_events (id, booking_id, from_status, to_status, actor_id, actor_type, reason, at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard.sql}`,
      )
      .bind(
        newId(),
        booking.id,
        booking.status,
        spec.to,
        spec.actor.id,
        spec.actor.type,
        spec.reason ?? null,
        at,
        ...guard.params,
      ),
    ...(spec.actor.type === "admin"
      ? [
          db
            .prepare(
              `INSERT INTO audit_logs (id, actor_id, actor_email, action, target_table, target_id, changed_fields, at)
               SELECT ?, ?, ?, ?, 'bookings', ?, ?, ? WHERE ${guard.sql}`,
            )
            .bind(
              newId(),
              spec.actor.id,
              spec.actor.email ?? "",
              `booking.${spec.to}`,
              booking.id,
              JSON.stringify(["status", ...sets.map(([column]) => column)]),
              at,
              ...guard.params,
            ),
        ]
      : []),
    ...extra(guard),
  ];
  return { statements, guard };
}

/** Runs a prepared transition. Throws `StaleBookingError` if the booking had moved on. */
export async function runTransition(
  db: D1Database,
  prepared: PreparedTransition,
  leading: readonly D1PreparedStatement[] = [],
): Promise<D1Result[]> {
  const results = await db.batch([...leading, ...prepared.statements]);
  const update = results[leading.length];
  if (!update || update.meta.changes !== 1) throw new StaleBookingError();
  return results;
}

/** A guarded ledger insert. Throws if the amount has the wrong sign for its type. */
export function ledgerStatement(
  db: D1Database,
  guard: Guard | null,
  entry: {
    bookingId: string;
    type: LedgerEntryType;
    amountSen: number;
    method: "gateway" | "duitnow" | "cash" | "deposit";
    reference?: string;
    note?: string;
    createdBy: string;
    at: Date;
  },
): D1PreparedStatement {
  if (!hasLedgerSign(entry.type, entry.amountSen)) {
    throw new Error(`Ledger ${entry.type} cannot be ${entry.amountSen.toString()}`);
  }
  const values = [
    newId(),
    entry.bookingId,
    entry.type,
    entry.amountSen,
    entry.method,
    entry.reference ?? "",
    entry.note ?? "",
    entry.createdBy,
    entry.at.toISOString(),
  ];
  const columns =
    "(id, booking_id, type, amount_sen, method, reference, note, created_by, created_at)";
  return guard
    ? db
        .prepare(
          `INSERT INTO ledger_entries ${columns} SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard.sql}`,
        )
        .bind(...values, ...guard.params)
    : db
        .prepare(`INSERT INTO ledger_entries ${columns} VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(...values);
}

/** Deposit still held for a booking: the signed sum of its deposit entries. */
export async function depositBalance(db: D1Database, bookingId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(amount_sen), 0) AS balance FROM ledger_entries
       WHERE booking_id = ? AND type IN ('DEPOSIT_IN', 'DEPOSIT_REFUND', 'DEPOSIT_DEDUCTION')`,
    )
    .bind(bookingId)
    .first<{ balance: number }>();
  return row?.balance ?? 0;
}

export function lockedDatesOf(booking: Pick<BookingRow, "locked_dates">): string[] {
  const parsed: unknown = JSON.parse(booking.locked_dates);
  return Array.isArray(parsed)
    ? parsed.filter((date): date is string => typeof date === "string")
    : [];
}
