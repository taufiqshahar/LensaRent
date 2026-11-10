import { describe, expect, it } from "vitest";
import {
  bufferHoursFor,
  isPeakDate,
  lockedDates,
  rentalDays,
  validateRentalPeriod,
} from "./duration";
import { DomainError } from "./errors";
import { addHours, addMinutes, mytDateTime } from "./time";

const buffer = { normalHours: 12, peakHours: 24 };
const peakPeriods = [{ from: "2026-12-24", to: "2026-12-26", label: "Krismas" }];

describe("rentalDays", () => {
  const pickup = mytDateTime("2026-12-05", "09:00");

  it.each([
    [1, 1],
    [24, 1],
    [47, 2],
    [48, 2],
    [72, 3],
    [168, 7],
  ])("%d hours is %d day(s)", (hours, days) => {
    expect(rentalDays(pickup, addHours(pickup, hours))).toBe(days);
  });

  it("counts a started 24-hour block as a full day", () => {
    expect(rentalDays(pickup, addMinutes(addHours(pickup, 24), 1))).toBe(2);
  });

  it("rejects a return that is not after pickup", () => {
    expect(() => rentalDays(pickup, pickup)).toThrow(DomainError);
    expect(() => rentalDays(pickup, addHours(pickup, -1))).toThrow(DomainError);
    expect(() => rentalDays(pickup, new Date(NaN))).toThrow(DomainError);
  });
});

describe("peak periods and buffer", () => {
  it("treats both ends of a peak period as peak", () => {
    expect(isPeakDate("2026-12-23", peakPeriods)).toBe(false);
    expect(isPeakDate("2026-12-24", peakPeriods)).toBe(true);
    expect(isPeakDate("2026-12-26", peakPeriods)).toBe(true);
    expect(isPeakDate("2026-12-27", peakPeriods)).toBe(false);
    expect(isPeakDate("2026-12-25", [])).toBe(false);
  });

  it("uses the peak buffer when the return day is a peak day", () => {
    expect(bufferHoursFor(mytDateTime("2026-12-10", "10:00"), buffer, peakPeriods)).toBe(12);
    expect(bufferHoursFor(mytDateTime("2026-12-26", "23:30"), buffer, peakPeriods)).toBe(24);
    expect(bufferHoursFor(mytDateTime("2026-12-27", "00:30"), buffer, peakPeriods)).toBe(12);
  });
});

describe("lockedDates", () => {
  it("locks pickup day through the day the buffer ends", () => {
    expect(
      lockedDates({
        pickupAt: mytDateTime("2026-12-05", "09:00"),
        returnSlotEnd: mytDateTime("2026-12-06", "10:00"), // buffer ends 22:00 the same day
        buffer,
        peakPeriods,
      }),
    ).toEqual(["2026-12-05", "2026-12-06"]);
  });

  it("locks the next day when an evening return's buffer runs past midnight", () => {
    expect(
      lockedDates({
        pickupAt: mytDateTime("2026-12-04", "20:00"),
        returnSlotEnd: mytDateTime("2026-12-05", "22:00"), // buffer ends 10:00 on the 6th
        buffer,
        peakPeriods,
      }),
    ).toEqual(["2026-12-04", "2026-12-05", "2026-12-06"]);
  });

  it("does not lock the next day when the buffer ends exactly at midnight", () => {
    expect(
      lockedDates({
        pickupAt: mytDateTime("2026-12-05", "09:00"),
        returnSlotEnd: mytDateTime("2026-12-06", "12:00"), // buffer ends 00:00 on the 7th
        buffer,
        peakPeriods,
      }),
    ).toEqual(["2026-12-05", "2026-12-06"]);
  });

  it("locks the next day once the buffer runs one minute past midnight", () => {
    expect(
      lockedDates({
        pickupAt: mytDateTime("2026-12-05", "09:00"),
        returnSlotEnd: mytDateTime("2026-12-06", "12:01"),
        buffer,
        peakPeriods,
      }),
    ).toEqual(["2026-12-05", "2026-12-06", "2026-12-07"]);
  });

  it("applies the longer peak buffer", () => {
    expect(
      lockedDates({
        pickupAt: mytDateTime("2026-12-24", "09:00"),
        returnSlotEnd: mytDateTime("2026-12-25", "10:00"), // 24h buffer ends 10:00 on the 26th
        buffer,
        peakPeriods,
      }),
    ).toEqual(["2026-12-24", "2026-12-25", "2026-12-26"]);
  });

  it("handles a zero buffer and year boundaries", () => {
    expect(
      lockedDates({
        pickupAt: mytDateTime("2026-12-31", "09:00"),
        returnSlotEnd: mytDateTime("2027-01-01", "10:00"),
        buffer: { normalHours: 0, peakHours: 0 },
        peakPeriods: [],
      }),
    ).toEqual(["2026-12-31", "2027-01-01"]);
  });

  it("rejects a return slot that does not end after pickup", () => {
    const pickupAt = mytDateTime("2026-12-05", "09:00");
    expect(() => lockedDates({ pickupAt, returnSlotEnd: pickupAt, buffer, peakPeriods })).toThrow(
      DomainError,
    );
  });
});

describe("validateRentalPeriod", () => {
  const now = mytDateTime("2026-12-01", "09:00");
  const rules = { now, minLeadHours: 24, maxRentalDays: 7 };

  it("accepts a period that meets every rule, including the exact limits", () => {
    const pickupAt = addHours(now, 24);
    expect(validateRentalPeriod({ ...rules, pickupAt, returnAt: addHours(pickupAt, 24 * 7) })).toBe(
      null,
    );
  });

  it("requires the return to be after pickup", () => {
    const pickupAt = addHours(now, 48);
    expect(validateRentalPeriod({ ...rules, pickupAt, returnAt: pickupAt })).toBe(
      "RETURN_NOT_AFTER_PICKUP",
    );
  });

  it("requires the minimum lead time", () => {
    const pickupAt = addMinutes(addHours(now, 24), -1);
    expect(validateRentalPeriod({ ...rules, pickupAt, returnAt: addHours(pickupAt, 24) })).toBe(
      "LEAD_TIME_TOO_SHORT",
    );
  });

  it("caps the rental length", () => {
    const pickupAt = addHours(now, 48);
    expect(
      validateRentalPeriod({
        ...rules,
        pickupAt,
        returnAt: addMinutes(addHours(pickupAt, 168), 1),
      }),
    ).toBe("EXCEEDS_MAX_RENTAL_DAYS");
  });
});
