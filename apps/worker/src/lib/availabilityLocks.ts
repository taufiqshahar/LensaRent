import type { DateString } from "@lensarent/shared";
import { isDateString } from "@lensarent/shared";
import { isUniqueViolation, placeholders } from "./db";

/**
 * Anti double-booking (docs/DECISIONS.md, ADR-002 and ADR-017).
 *
 * A unit is used by at most one booking, hold or maintenance block per calendar day:
 * one row per unit per day in `availability_locks`, whose PRIMARY KEY (unit_id, date)
 * makes a second claim on a day impossible.
 *
 * All the days of a booking are inserted in ONE D1 batch (one SQL transaction), together
 * with whatever else belongs to the same decision (the booking row, its first event). If
 * any single day is taken, the whole batch is rolled back: no partial locks, no rollback
 * code of our own, and of any number of racing requests exactly one wins. Releasing a
 * lock deletes the row.
 */

/** Keeps a lock batch small and within D1's bound-parameter limit. */
export const MAX_LOCK_DAYS = 60;

const UNIT_ID_PATTERN = /^[A-Za-z0-9-]{1,40}$/;

/** Who a lock belongs to. A hold or booking belongs to a booking; maintenance to a block. */
export type LockOwner = { bookingId: string } | { blockId: string };

export type LockRequest = { unitId: string; dates: readonly DateString[] } & (
  | { kind: "hold"; bookingId: string; holdExpiresAt: Date }
  | { kind: "booking"; bookingId: string }
  | { kind: "maintenance"; blockId: string }
);

export type AcquireResult =
  /** `alreadyHeld` is true when this owner already held every day (an idempotent retry). */
  { acquired: true; alreadyHeld: boolean } | { acquired: false; conflictingDates: DateString[] };

export class LockStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LockStateError";
  }
}

interface LockRow {
  date: string;
  booking_id: string | null;
  block_id: string | null;
}

function assertLockTarget(unitId: string, dates: readonly DateString[]): void {
  if (!UNIT_ID_PATTERN.test(unitId)) throw new LockStateError("Invalid unit id");
  if (dates.length === 0 || dates.length > MAX_LOCK_DAYS) {
    throw new LockStateError(`A lock must cover 1 to ${MAX_LOCK_DAYS.toString()} days`);
  }
  if (!dates.every(isDateString) || new Set(dates).size !== dates.length) {
    throw new LockStateError("Lock dates must be valid and must not repeat");
  }
}

function ownerOf(request: LockRequest): LockOwner {
  return request.kind === "maintenance"
    ? { blockId: request.blockId }
    : { bookingId: request.bookingId };
}

function isOwnedBy(row: LockRow, owner: LockOwner): boolean {
  return "bookingId" in owner ? row.booking_id === owner.bookingId : row.block_id === owner.blockId;
}

const INSERT_LOCK = `INSERT INTO availability_locks
  (unit_id, date, kind, booking_id, block_id, hold_expires_at, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)`;

/**
 * Locks every requested day for one unit, or none of them.
 *
 * `extraStatements` run in the same transaction, so the caller's booking rows exist if and
 * only if the locks do.
 *
 * Safe to retry: if this owner already holds every day (for example the first attempt
 * succeeded but its response was lost), the result is `acquired` with `alreadyHeld`.
 */
export async function acquireDayLocks(
  db: D1Database,
  request: LockRequest,
  now: Date,
  extraStatements: readonly D1PreparedStatement[] = [],
): Promise<AcquireResult> {
  const { unitId, dates } = request;
  assertLockTarget(unitId, dates);
  const owner = ownerOf(request);

  const inserts = dates.map((date) =>
    db
      .prepare(INSERT_LOCK)
      .bind(
        unitId,
        date,
        request.kind,
        "bookingId" in owner ? owner.bookingId : null,
        "blockId" in owner ? owner.blockId : null,
        request.kind === "hold" ? request.holdExpiresAt.toISOString() : null,
        now.toISOString(),
      ),
  );

  try {
    await db.batch([...inserts, ...extraStatements]);
    return { acquired: true, alreadyHeld: false };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;

    // Find out who holds the days. Also covers a retry: this owner may hold them already.
    const { results } = await db
      .prepare(
        `SELECT date, booking_id, block_id FROM availability_locks
         WHERE unit_id = ? AND date IN (${placeholders(dates.length)})`,
      )
      .bind(unitId, ...dates)
      .all<LockRow>();

    const conflictingDates = dates.filter((date) =>
      results.some((row) => row.date === date && !isOwnedBy(row, owner)),
    );
    if (conflictingDates.length > 0) return { acquired: false, conflictingDates };

    const mine = results.filter((row) => isOwnedBy(row, owner));
    if (mine.length === dates.length) return { acquired: true, alreadyHeld: true };
    if (mine.length > 0) {
      // Batches are atomic, so holding only some of the days means the data was edited by hand.
      throw new LockStateError("Owner holds only part of the requested days");
    }
    // Nobody holds the days: the duplicate came from one of the caller's own statements.
    throw error;
  }
}

export interface ReleaseRequest {
  unitId: string;
  dates: readonly DateString[];
  owner: LockOwner;
}

/**
 * Deletes the owner's locks on the given days, in the same transaction as
 * `extraStatements`. Days locked by anyone else are left untouched, so a late or repeated
 * release can never free another booking's days. Returns the days actually released.
 */
export async function releaseDayLocks(
  db: D1Database,
  request: ReleaseRequest,
  extraStatements: readonly D1PreparedStatement[] = [],
): Promise<DateString[]> {
  const { unitId, dates, owner } = request;
  assertLockTarget(unitId, dates);

  const ownerColumn = "bookingId" in owner ? "booking_id" : "block_id";
  const ownerId = "bookingId" in owner ? owner.bookingId : owner.blockId;
  const [deleted] = await db.batch<{ date: string }>([
    db
      .prepare(
        `DELETE FROM availability_locks
         WHERE unit_id = ? AND ${ownerColumn} = ? AND date IN (${placeholders(dates.length)})
         RETURNING date`,
      )
      .bind(unitId, ownerId, ...dates),
    ...extraStatements,
  ]);

  const released = new Set((deleted?.results ?? []).map((row) => row.date));
  return dates.filter((date) => released.has(date));
}

/** SQL guard from `prepareTransition`: true only if that status change was applied. */
interface StatementGuard {
  sql: string;
  params: readonly string[];
}

/**
 * Deletes every lock a booking holds, only if `guard` holds. For status changes that end
 * a booking's claim on its days (cancelled, refund pending), in the same batch.
 */
export function releaseBookingLocksStatement(
  db: D1Database,
  bookingId: string,
  guard: StatementGuard,
): D1PreparedStatement {
  return db
    .prepare(`DELETE FROM availability_locks WHERE booking_id = ? AND ${guard.sql}`)
    .bind(bookingId, ...guard.params);
}

/** Turns a paid hold's locks into booking locks (no expiry), only if `guard` holds. */
export function confirmBookingLocksStatement(
  db: D1Database,
  bookingId: string,
  guard: StatementGuard,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE availability_locks SET kind = 'booking', hold_expires_at = NULL
       WHERE booking_id = ? AND kind = 'hold' AND ${guard.sql}`,
    )
    .bind(bookingId, ...guard.params);
}
