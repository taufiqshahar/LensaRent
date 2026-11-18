import { addDays, eachDate } from "@lensarent/shared";
import { describe, expect, it } from "vitest";
import type { AcquireResult } from "../../src/lib/availabilityLocks";
import {
  LockStateError,
  MAX_LOCK_DAYS,
  acquireDayLocks,
  releaseDayLocks,
} from "../../src/lib/availabilityLocks";
import { auditStatement } from "../../src/lib/audit";
import { testDb, uniqueId } from "../helpers";

const db = testDb();
const now = new Date("2026-12-01T12:00:00.000Z");
const holdExpiresAt = new Date("2026-12-01T12:15:00.000Z");
const days = (from: string, count: number) => eachDate(from, addDays(from, count - 1));

function hold(unitId: string, bookingId: string, dates: readonly string[]) {
  return { kind: "hold" as const, unitId, bookingId, dates, holdExpiresAt };
}

/** Stand-in for "the booking row" a caller commits with its locks (bookings arrive in Fasa 2). */
function marker(targetId: string): D1PreparedStatement {
  return auditStatement(db, {
    actor: { id: "system", email: "system" },
    action: "test.marker",
    targetTable: "bookings",
    targetId,
    at: now,
  });
}

async function markerExists(targetId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'test.marker' AND target_id = ?")
    .bind(targetId)
    .first<{ n: number }>();
  return (row?.n ?? 0) > 0;
}

async function lockedBy(unitId: string, dates: readonly string[]): Promise<(string | null)[]> {
  const { results } = await db
    .prepare("SELECT date, booking_id, block_id FROM availability_locks WHERE unit_id = ?")
    .bind(unitId)
    .all<{ date: string; booking_id: string | null; block_id: string | null }>();
  return dates.map((date) => {
    const row = results.find((candidate) => candidate.date === date);
    return row ? (row.booking_id ?? row.block_id) : null;
  });
}

describe("acquireDayLocks", () => {
  it("creates one row per day", async () => {
    const unitId = uniqueId("unit");
    await expect(
      acquireDayLocks(db, hold(unitId, "bk-1", days("2026-12-24", 3)), now),
    ).resolves.toEqual({
      acquired: true,
      alreadyHeld: false,
    });

    const row = await db
      .prepare("SELECT * FROM availability_locks WHERE unit_id = ? AND date = '2026-12-25'")
      .bind(unitId)
      .first();
    expect(row).toEqual({
      unit_id: unitId,
      date: "2026-12-25",
      kind: "hold",
      booking_id: "bk-1",
      block_id: null,
      hold_expires_at: holdExpiresAt.toISOString(),
      created_at: now.toISOString(),
    });
  });

  it("commits the caller's statements together with the locks", async () => {
    const unitId = uniqueId("unit");
    const bookingId = uniqueId("bk");
    await acquireDayLocks(db, hold(unitId, bookingId, days("2026-12-24", 2)), now, [
      marker(bookingId),
    ]);
    expect(await markerExists(bookingId)).toBe(true);
  });

  it("refuses an overlapping request and leaves nothing behind", async () => {
    const unitId = uniqueId("unit");
    const loser = uniqueId("bk");
    await acquireDayLocks(db, hold(unitId, "bk-1", days("2026-12-24", 3)), now); // 24, 25, 26

    const result = await acquireDayLocks(
      db,
      hold(unitId, loser, days("2026-12-22", 4)), // 22, 23, 24, 25
      now,
      [marker(loser)],
    );

    expect(result).toEqual({ acquired: false, conflictingDates: ["2026-12-24", "2026-12-25"] });
    // All or nothing: the free days were not locked and the caller's row was not written.
    expect(await lockedBy(unitId, days("2026-12-22", 5))).toEqual([
      null,
      null,
      "bk-1",
      "bk-1",
      "bk-1",
    ]);
    expect(await markerExists(loser)).toBe(false);
  });

  it("is safe to retry for the same owner", async () => {
    const request = hold(uniqueId("unit"), "bk-1", days("2026-12-24", 2));
    await acquireDayLocks(db, request, now);
    await expect(acquireDayLocks(db, request, now)).resolves.toEqual({
      acquired: true,
      alreadyHeld: true,
    });
  });

  it("keeps units independent of each other", async () => {
    const dates = days("2026-12-24", 2);
    await acquireDayLocks(db, hold(uniqueId("unit"), "bk-1", dates), now);
    await expect(
      acquireDayLocks(db, hold(uniqueId("unit"), "bk-2", dates), now),
    ).resolves.toMatchObject({
      acquired: true,
    });
  });

  it("stops a maintenance block from covering a booked day, and the reverse", async () => {
    const unitId = uniqueId("unit");
    await acquireDayLocks(
      db,
      { kind: "booking", unitId, bookingId: "bk-1", dates: ["2026-12-24"] },
      now,
    );

    await expect(
      acquireDayLocks(
        db,
        { kind: "maintenance", unitId, blockId: "blk-1", dates: days("2026-12-23", 3) },
        now,
      ),
    ).resolves.toEqual({ acquired: false, conflictingDates: ["2026-12-24"] });

    await acquireDayLocks(
      db,
      { kind: "maintenance", unitId, blockId: "blk-2", dates: ["2026-12-30"] },
      now,
    );
    await expect(
      acquireDayLocks(db, hold(unitId, "bk-3", days("2026-12-29", 3)), now),
    ).resolves.toEqual({
      acquired: false,
      conflictingDates: ["2026-12-30"],
    });
  });

  it("fails loudly if an owner somehow holds only part of the days", async () => {
    const unitId = uniqueId("unit");
    await acquireDayLocks(db, hold(unitId, "bk-1", ["2026-12-24"]), now);
    await expect(
      acquireDayLocks(db, hold(unitId, "bk-1", days("2026-12-24", 2)), now),
    ).rejects.toThrow(LockStateError);
  });

  it("passes on a duplicate that came from the caller's own statements", async () => {
    const unitId = uniqueId("unit");
    const duplicate = db
      .prepare("INSERT INTO rate_limits (key, count, expires_at) VALUES (?, 1, ?)")
      .bind(uniqueId("dup"), now.toISOString());
    const sameAgain = duplicate;
    await expect(
      acquireDayLocks(db, hold(unitId, "bk-1", ["2026-12-24"]), now, [duplicate, sameAgain]),
    ).rejects.toThrow(/UNIQUE/);
    expect(await lockedBy(unitId, ["2026-12-24"])).toEqual([null]);
  });

  it.each([
    ["an invalid unit id", "unit/01", ["2026-12-24"]],
    ["no days", "unit01", []],
    ["a repeated day", "unit01", ["2026-12-24", "2026-12-24"]],
    ["an impossible date", "unit01", ["2026-02-30"]],
    ["too many days", "unit01", days("2026-01-01", MAX_LOCK_DAYS + 1)],
  ])("rejects %s", async (_label, unitId, dates) => {
    await expect(acquireDayLocks(db, hold(unitId, "bk-1", dates), now)).rejects.toThrow(
      LockStateError,
    );
    await expect(
      releaseDayLocks(db, { unitId, dates, owner: { bookingId: "bk-1" } }),
    ).rejects.toThrow(LockStateError);
  });
});

describe("releaseDayLocks", () => {
  it("frees the days so they can be booked again", async () => {
    const unitId = uniqueId("unit");
    const dates = days("2026-12-24", 3);
    await acquireDayLocks(db, hold(unitId, "bk-1", dates), now);

    await expect(
      releaseDayLocks(db, { unitId, dates, owner: { bookingId: "bk-1" } }),
    ).resolves.toEqual(dates);
    expect(await lockedBy(unitId, dates)).toEqual([null, null, null]);
    await expect(acquireDayLocks(db, hold(unitId, "bk-2", dates), now)).resolves.toEqual({
      acquired: true,
      alreadyHeld: false,
    });
  });

  it("applies the caller's statements in the same transaction", async () => {
    const unitId = uniqueId("unit");
    const ref = uniqueId("cancel");
    const dates = days("2026-12-24", 2);
    await acquireDayLocks(db, hold(unitId, "bk-1", dates), now);
    await releaseDayLocks(db, { unitId, dates, owner: { bookingId: "bk-1" } }, [marker(ref)]);
    expect(await markerExists(ref)).toBe(true);
    expect(await lockedBy(unitId, dates)).toEqual([null, null]);
  });

  it("never frees days that belong to someone else", async () => {
    const unitId = uniqueId("unit");
    const dates = days("2026-12-24", 2);
    await acquireDayLocks(db, hold(unitId, "bk-1", dates), now);

    await expect(
      releaseDayLocks(db, { unitId, dates, owner: { bookingId: "bk-other" } }),
    ).resolves.toEqual([]);
    await expect(
      releaseDayLocks(db, { unitId, dates, owner: { blockId: "bk-1" } }),
    ).resolves.toEqual([]);
    expect(await lockedBy(unitId, dates)).toEqual(["bk-1", "bk-1"]);
  });

  it("does nothing the second time", async () => {
    const unitId = uniqueId("unit");
    const dates = ["2026-12-24"];
    await acquireDayLocks(db, { kind: "maintenance", unitId, blockId: "blk-1", dates }, now);
    const release = () => releaseDayLocks(db, { unitId, dates, owner: { blockId: "blk-1" } });
    await expect(release()).resolves.toEqual(dates);
    await expect(release()).resolves.toEqual([]);
  });
});

/**
 * The most important test in the system (master prompt §6, §12): when many customers go
 * for the same days at the same moment, exactly one of them gets the unit.
 *
 * Each round fires 20 simultaneous requests at one unit. Their date ranges are staggered
 * but all share at least one day, and each request also writes its own "booking" row in
 * the same transaction. Afterwards exactly one request must have won, only the winner's
 * locks and row may exist, and every loser must have been told which of the winner's days
 * blocked it.
 */
describe("simultaneous requests for the same days", () => {
  const ROUNDS = 50;
  const CONTENDERS = 20;

  it(`lets exactly one of ${CONTENDERS.toString()} win, ${ROUNDS.toString()} rounds in a row`, async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const unitId = uniqueId("race");
      const requests = Array.from({ length: CONTENDERS }, (_, index) => ({
        bookingId: uniqueId(`bk${index.toString()}`),
        // Starts on the 10th, 11th or 12th for three days: every range includes the 12th.
        dates: days(addDays("2027-01-10", index % 3), 3),
      }));

      const results: AcquireResult[] = await Promise.all(
        requests.map(({ bookingId, dates }) =>
          acquireDayLocks(db, hold(unitId, bookingId, dates), now, [marker(bookingId)]),
        ),
      );

      const winners = requests.filter((_, index) => results[index]!.acquired);
      expect(winners, `round ${round.toString()}`).toHaveLength(1);
      const winner = winners[0]!;

      results.forEach((result, index) => {
        if (result.acquired) return;
        expect(result.conflictingDates.length).toBeGreaterThan(0);
        for (const date of result.conflictingDates) {
          expect(winner.dates).toContain(date);
          expect(requests[index]!.dates).toContain(date);
        }
      });

      const allDates = days("2027-01-10", 5);
      expect(await lockedBy(unitId, allDates)).toEqual(
        allDates.map((date) => (winner.dates.includes(date) ? winner.bookingId : null)),
      );
      const written = await Promise.all(requests.map(({ bookingId }) => markerExists(bookingId)));
      expect(requests.filter((_, index) => written[index]).map((r) => r.bookingId)).toEqual([
        winner.bookingId,
      ]);
    }
  });

  it("hands released days to exactly one of the customers waiting for them", async () => {
    const unitId = uniqueId("handover");
    const dates = days("2027-03-01", 3);
    await acquireDayLocks(db, hold(unitId, "expired", dates), now);
    await releaseDayLocks(db, { unitId, dates, owner: { bookingId: "expired" } });

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        acquireDayLocks(db, hold(unitId, `next-${index.toString()}`, dates), now),
      ),
    );
    expect(results.filter((result) => result.acquired)).toHaveLength(1);
  });
});
