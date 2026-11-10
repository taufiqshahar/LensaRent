import { addDays, eachDate } from "@lensarent/shared";
import { describe, expect, it } from "vitest";
import type { AcquireResult } from "../../src/lib/availabilityLocks";
import {
  LockStateError,
  MAX_LOCK_DAYS,
  acquireDayLocks,
  lockPath,
  releaseDayLocks,
} from "../../src/lib/availabilityLocks";
import { createDoc, setDoc, updateDoc } from "../../src/lib/firestore";
import { emulatorDb, uniqueId } from "../helpers";

const db = emulatorDb();
const holdExpiresAt = new Date("2026-12-24T12:15:00.000Z");
const days = (from: string, count: number) => eachDate(from, addDays(from, count - 1));

function hold(unitId: string, bookingId: string, dates: readonly string[]) {
  return { kind: "hold" as const, unitId, bookingId, dates, holdExpiresAt };
}

async function lockedBy(unitId: string, dates: readonly string[]): Promise<(string | null)[]> {
  const snapshots = await db.getAll(dates.map((date) => lockPath(unitId, date)));
  return snapshots.map((snapshot) =>
    snapshot.exists ? ((snapshot.data!.bookingId ?? snapshot.data!.blockId) as string) : null,
  );
}

describe("acquireDayLocks", () => {
  it("creates one lock document per day", async () => {
    const unitId = uniqueId("unit");
    const dates = days("2026-12-24", 3);

    await expect(acquireDayLocks(db, hold(unitId, "bk-1", dates))).resolves.toEqual({
      acquired: true,
      alreadyHeld: false,
    });

    const snapshot = await db.get(lockPath(unitId, "2026-12-25"));
    expect(snapshot.id).toBe(`${unitId}_2026-12-25`);
    expect(snapshot.data).toEqual({
      unitId,
      date: "2026-12-25",
      kind: "hold",
      bookingId: "bk-1",
      blockId: null,
      holdExpiresAt,
      createdAt: expect.any(Date) as Date,
    });
  });

  it("commits the caller's documents together with the locks", async () => {
    const unitId = uniqueId("unit");
    const bookingPath = `bookings/${uniqueId("bk")}`;

    await acquireDayLocks(db, hold(unitId, "bk-1", days("2026-12-24", 2)), [
      createDoc(bookingPath, { status: "pending_payment" }),
    ]);

    expect((await db.get(bookingPath)).data).toEqual({ status: "pending_payment" });
  });

  it("refuses an overlapping request and leaves nothing behind", async () => {
    const unitId = uniqueId("unit");
    const loserBooking = `bookings/${uniqueId("bk")}`;
    await acquireDayLocks(db, hold(unitId, "bk-1", days("2026-12-24", 3))); // 24, 25, 26

    const result = await acquireDayLocks(
      db,
      hold(unitId, "bk-2", days("2026-12-22", 4)), // 22, 23, 24, 25
      [createDoc(loserBooking, { status: "pending_payment" })],
    );

    expect(result).toEqual({ acquired: false, conflictingDates: ["2026-12-24", "2026-12-25"] });
    // All or nothing: the free days were not locked and the booking was not created.
    expect(await lockedBy(unitId, days("2026-12-22", 5))).toEqual([
      null,
      null,
      "bk-1",
      "bk-1",
      "bk-1",
    ]);
    expect((await db.get(loserBooking)).exists).toBe(false);
  });

  it("is safe to retry for the same owner", async () => {
    const unitId = uniqueId("unit");
    const request = hold(unitId, "bk-1", days("2026-12-24", 2));
    await acquireDayLocks(db, request);

    await expect(acquireDayLocks(db, request)).resolves.toEqual({
      acquired: true,
      alreadyHeld: true,
    });
  });

  it("keeps units independent of each other", async () => {
    const dates = days("2026-12-24", 2);
    await acquireDayLocks(db, hold(uniqueId("unit"), "bk-1", dates));
    await expect(acquireDayLocks(db, hold(uniqueId("unit"), "bk-2", dates))).resolves.toMatchObject(
      {
        acquired: true,
      },
    );
  });

  it("stops a maintenance block from covering a booked day, and the reverse", async () => {
    const unitId = uniqueId("unit");
    await acquireDayLocks(db, {
      kind: "booking",
      unitId,
      bookingId: "bk-1",
      dates: ["2026-12-24"],
    });

    await expect(
      acquireDayLocks(db, {
        kind: "maintenance",
        unitId,
        blockId: "blk-1",
        dates: days("2026-12-23", 3),
      }),
    ).resolves.toEqual({ acquired: false, conflictingDates: ["2026-12-24"] });

    await acquireDayLocks(db, {
      kind: "maintenance",
      unitId,
      blockId: "blk-2",
      dates: ["2026-12-30"],
    });
    expect((await db.get(lockPath(unitId, "2026-12-30"))).data).toMatchObject({
      kind: "maintenance",
      blockId: "blk-2",
      bookingId: null,
      holdExpiresAt: null,
    });
    await expect(acquireDayLocks(db, hold(unitId, "bk-3", days("2026-12-29", 3)))).resolves.toEqual(
      {
        acquired: false,
        conflictingDates: ["2026-12-30"],
      },
    );
  });

  it("treats an unreadable lock document as taken", async () => {
    const unitId = uniqueId("unit");
    await db.commit([setDoc(lockPath(unitId, "2026-12-24"), { edited: "by hand" })]);

    await expect(acquireDayLocks(db, hold(unitId, "bk-1", ["2026-12-24"]))).resolves.toEqual({
      acquired: false,
      conflictingDates: ["2026-12-24"],
    });
  });

  it("fails loudly if an owner somehow holds only part of the days", async () => {
    const unitId = uniqueId("unit");
    await acquireDayLocks(db, hold(unitId, "bk-1", ["2026-12-24"]));

    await expect(acquireDayLocks(db, hold(unitId, "bk-1", days("2026-12-24", 2)))).rejects.toThrow(
      LockStateError,
    );
  });

  it.each([
    ["an invalid unit id", "unit/01", ["2026-12-24"]],
    ["no days", "unit01", []],
    ["a repeated day", "unit01", ["2026-12-24", "2026-12-24"]],
    ["an impossible date", "unit01", ["2026-02-30"]],
    ["too many days", "unit01", days("2026-01-01", MAX_LOCK_DAYS + 1)],
  ])("rejects %s", async (_label, unitId, dates) => {
    await expect(acquireDayLocks(db, hold(unitId, "bk-1", dates))).rejects.toThrow(LockStateError);
    await expect(
      releaseDayLocks(db, { unitId, dates, owner: { bookingId: "bk-1" } }),
    ).rejects.toThrow(LockStateError);
  });
});

describe("releaseDayLocks", () => {
  it("frees the days so they can be booked again", async () => {
    const unitId = uniqueId("unit");
    const dates = days("2026-12-24", 3);
    await acquireDayLocks(db, hold(unitId, "bk-1", dates));

    await expect(
      releaseDayLocks(db, { unitId, dates, owner: { bookingId: "bk-1" } }),
    ).resolves.toEqual(dates);
    expect(await lockedBy(unitId, dates)).toEqual([null, null, null]);

    await expect(acquireDayLocks(db, hold(unitId, "bk-2", dates))).resolves.toEqual({
      acquired: true,
      alreadyHeld: false,
    });
  });

  it("applies the caller's writes in the same commit", async () => {
    const unitId = uniqueId("unit");
    const bookingPath = `bookings/${uniqueId("bk")}`;
    const dates = days("2026-12-24", 2);
    await acquireDayLocks(db, hold(unitId, "bk-1", dates), [
      createDoc(bookingPath, { status: "pending_payment" }),
    ]);

    await releaseDayLocks(db, { unitId, dates, owner: { bookingId: "bk-1" } }, [
      updateDoc(bookingPath, { status: "cancelled", statusReason: "hold_expired" }),
    ]);

    expect((await db.get(bookingPath)).data).toEqual({
      status: "cancelled",
      statusReason: "hold_expired",
    });
    expect(await lockedBy(unitId, dates)).toEqual([null, null]);
  });

  it("never frees days that belong to someone else", async () => {
    const unitId = uniqueId("unit");
    const dates = days("2026-12-24", 2);
    await acquireDayLocks(db, hold(unitId, "bk-1", dates));

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
    await acquireDayLocks(db, { kind: "maintenance", unitId, blockId: "blk-1", dates });
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
 * but all share at least one day, and each request also creates its own booking document.
 * Afterwards exactly one request must have won, only the winner's locks and booking may
 * exist, and every loser must have been told which of the winner's days blocked it.
 *
 * Rounds use separate units, so several run at once to keep the suite quick; the emulator
 * waits two seconds whenever commits collide on a document.
 */
describe("simultaneous requests for the same days", () => {
  const ROUNDS = 50;
  const ROUNDS_AT_ONCE = 5;
  const CONTENDERS = 20;

  async function runRound(round: number): Promise<void> {
    const unitId = uniqueId("race");
    const run = uniqueId("run");
    const requests = Array.from({ length: CONTENDERS }, (_, index) => ({
      bookingId: `${run}-${index.toString()}`,
      // Starts on the 10th, 11th or 12th for three days: every range includes the 12th.
      dates: days(addDays("2027-01-10", index % 3), 3),
    }));

    const results: AcquireResult[] = await Promise.all(
      requests.map(({ bookingId, dates }) =>
        acquireDayLocks(db, hold(unitId, bookingId, dates), [
          createDoc(`bookings/${bookingId}`, { status: "pending_payment", unitId }),
        ]),
      ),
    );

    const winners = requests.filter((_, index) => results[index]!.acquired);
    expect(winners, `round ${round.toString()}`).toHaveLength(1);
    const winner = winners[0]!;

    // Every loser was refused because of days the winner holds.
    results.forEach((result, index) => {
      if (result.acquired) return;
      expect(result.conflictingDates.length).toBeGreaterThan(0);
      for (const date of result.conflictingDates) {
        expect(winner.dates).toContain(date);
        expect(requests[index]!.dates).toContain(date);
      }
    });

    // No orphans: only the winner's days are locked, and only the winner's booking exists.
    const allDates = days("2027-01-10", 5);
    expect(await lockedBy(unitId, allDates)).toEqual(
      allDates.map((date) => (winner.dates.includes(date) ? winner.bookingId : null)),
    );
    const bookings = await db.getAll(requests.map(({ bookingId }) => `bookings/${bookingId}`));
    expect(bookings.filter((snapshot) => snapshot.exists).map((snapshot) => snapshot.id)).toEqual([
      winner.bookingId,
    ]);
  }

  it(
    `lets exactly one of ${CONTENDERS.toString()} win, ${ROUNDS.toString()} rounds in a row`,
    { timeout: 300_000 },
    async () => {
      for (let first = 0; first < ROUNDS; first += ROUNDS_AT_ONCE) {
        await Promise.all(
          Array.from({ length: Math.min(ROUNDS_AT_ONCE, ROUNDS - first) }, (_, offset) =>
            runRound(first + offset),
          ),
        );
      }
    },
  );

  it("lets exactly one of two identical requests win", async () => {
    for (let round = 0; round < 20; round++) {
      const unitId = uniqueId("pair");
      const dates = days("2027-02-01", 2);
      const results = await Promise.all([
        acquireDayLocks(db, hold(unitId, "bk-a", dates)),
        acquireDayLocks(db, hold(unitId, "bk-b", dates)),
      ]);
      expect(results.filter((result) => result.acquired)).toHaveLength(1);
    }
  });

  it("hands released days to exactly one of the customers waiting for them", async () => {
    const unitId = uniqueId("handover");
    const dates = days("2027-03-01", 3);
    await acquireDayLocks(db, hold(unitId, "expired", dates));
    await releaseDayLocks(db, { unitId, dates, owner: { bookingId: "expired" } });

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        acquireDayLocks(db, hold(unitId, `next-${index.toString()}`, dates)),
      ),
    );
    expect(results.filter((result) => result.acquired)).toHaveLength(1);
  });
});
