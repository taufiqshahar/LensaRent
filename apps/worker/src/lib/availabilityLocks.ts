import type { DateString } from "@lensarent/shared";
import { isDateString, lockKindSchema } from "@lensarent/shared";
import { z } from "zod";
import type { DocumentSnapshot, Firestore, Write } from "./firestore";
import { createDoc, deleteDoc, isFirestoreError, serverTimestamp } from "./firestore";

/**
 * Anti double-booking (docs/DECISIONS.md, ADR-002).
 *
 * A unit is used by at most one booking, hold or maintenance block per calendar day. That
 * is recorded as one document per unit per day, `availabilityLocks/{unitId}_{yyyy-MM-dd}`,
 * and a document existing IS the lock.
 *
 * All the days of a booking are created in ONE atomic commit, each with the precondition
 * "must not exist", together with whatever else belongs to the same decision (the booking
 * and its first event). If any single day is taken, Firestore rejects the entire commit:
 * no partial locks, no rollback step, and of any number of racing requests exactly one
 * wins. Releasing a lock deletes the document.
 */
export const LOCKS_COLLECTION = "availabilityLocks";

/** Keeps a lock commit far below Firestore's 500-writes-per-commit ceiling. */
export const MAX_LOCK_DAYS = 60;

const UNIT_ID_PATTERN = /^[A-Za-z0-9-]{1,40}$/;

export function lockPath(unitId: string, date: DateString): string {
  return `${LOCKS_COLLECTION}/${unitId}_${date}`;
}

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

const lockDocumentSchema = z.object({
  unitId: z.string(),
  date: z.string(),
  kind: lockKindSchema,
  bookingId: z.string().nullable(),
  blockId: z.string().nullable(),
  holdExpiresAt: z.date().nullable(),
});
export type LockDocument = z.infer<typeof lockDocumentSchema>;

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

/** An unreadable lock document is treated as someone else's: the safe answer is "taken". */
function isOwnedBy(snapshot: DocumentSnapshot, unitId: string, owner: LockOwner): boolean {
  const parsed = lockDocumentSchema.safeParse(snapshot.data);
  if (!parsed.success || parsed.data.unitId !== unitId) return false;
  return "bookingId" in owner
    ? parsed.data.bookingId === owner.bookingId
    : parsed.data.blockId === owner.blockId;
}

const MAX_ATTEMPTS = 3;

/**
 * Locks every requested day for one unit, or none of them.
 *
 * `extraWrites` are committed in the same atomic commit, so the caller's booking documents
 * exist if and only if the locks do.
 *
 * Safe to retry: if this owner already holds every day (for example the first attempt
 * succeeded but its response was lost), the result is `acquired` with `alreadyHeld`.
 */
export async function acquireDayLocks(
  db: Firestore,
  request: LockRequest,
  extraWrites: readonly Write[] = [],
): Promise<AcquireResult> {
  const { unitId, dates } = request;
  assertLockTarget(unitId, dates);
  const owner = ownerOf(request);

  const lockWrites = dates.map((date) =>
    createDoc(lockPath(unitId, date), {
      unitId,
      date,
      kind: request.kind,
      bookingId: "bookingId" in owner ? owner.bookingId : null,
      blockId: "blockId" in owner ? owner.blockId : null,
      holdExpiresAt: request.kind === "hold" ? request.holdExpiresAt : null,
      createdAt: serverTimestamp(),
    }),
  );

  for (let attempt = 1; ; attempt++) {
    try {
      await db.commit([...lockWrites, ...extraWrites]);
      return { acquired: true, alreadyHeld: false };
    } catch (error) {
      const taken = isFirestoreError(error, "ALREADY_EXISTS");
      const transient =
        isFirestoreError(error, "ABORTED") || isFirestoreError(error, "UNAVAILABLE");
      if (!taken && !transient) throw error;

      // Find out who holds the days. Also covers a lost response: the commit may have won.
      const snapshots = await db.getAll(dates.map((date) => lockPath(unitId, date)));
      const existing = snapshots.filter((snapshot) => snapshot.exists);
      const mine = existing.filter((snapshot) => isOwnedBy(snapshot, unitId, owner));

      if (mine.length < existing.length) {
        const conflictingDates = dates.filter((_, index) => {
          const snapshot = snapshots[index];
          return snapshot?.exists === true && !isOwnedBy(snapshot, unitId, owner);
        });
        return { acquired: false, conflictingDates };
      }
      if (mine.length === dates.length) return { acquired: true, alreadyHeld: true };
      if (mine.length > 0) {
        // Commits are atomic, so holding only some of the days means the data was tampered with.
        throw new LockStateError("Owner holds only part of the requested days");
      }
      // Nobody holds the days any more (released meanwhile, or a transient failure): try again.
      if (attempt >= MAX_ATTEMPTS) throw error;
    }
  }
}

export interface ReleaseRequest {
  unitId: string;
  dates: readonly DateString[];
  owner: LockOwner;
}

/**
 * Deletes the owner's locks on the given days, atomically with `extraWrites`. Days locked
 * by anyone else are left untouched, so a late or repeated release can never free another
 * booking's days. Returns the days that were actually released.
 */
export async function releaseDayLocks(
  db: Firestore,
  request: ReleaseRequest,
  extraWrites: readonly Write[] = [],
): Promise<DateString[]> {
  const { unitId, dates, owner } = request;
  assertLockTarget(unitId, dates);

  return db.runTransaction(async (tx) => {
    const snapshots = await tx.getAll(dates.map((date) => lockPath(unitId, date)));
    const released = dates.filter((_, index) => {
      const snapshot = snapshots[index];
      return snapshot?.exists === true && isOwnedBy(snapshot, unitId, owner);
    });
    tx.write(...released.map((date) => deleteDoc(lockPath(unitId, date))), ...extraWrites);
    return released;
  });
}
