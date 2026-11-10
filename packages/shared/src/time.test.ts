import { describe, expect, it } from "vitest";
import { DomainError } from "./errors";
import {
  MAX_DATE_RANGE_DAYS,
  MS_PER_HOUR,
  MYT_TIME_ZONE,
  addDays,
  addHours,
  addMinutes,
  dayOfWeek,
  diffDays,
  eachDate,
  formatMytDate,
  formatMytDateTime,
  isDateString,
  isTimeOfDay,
  mytDateString,
  mytDateTime,
} from "./time";

describe("isDateString", () => {
  it.each(["2026-12-24", "2028-02-29", "2026-01-01"])("accepts %s", (value) => {
    expect(isDateString(value)).toBe(true);
  });

  it.each([
    "2026-02-30",
    "2027-02-29",
    "2026-13-01",
    "2026-00-10",
    "24-12-2026",
    "2026-1-5",
    "",
    20261224,
    null,
  ])("rejects %s", (value) => {
    expect(isDateString(value)).toBe(false);
  });
});

describe("isTimeOfDay", () => {
  it.each(["00:00", "09:00", "23:59"])("accepts %s", (value) => {
    expect(isTimeOfDay(value)).toBe(true);
  });

  it.each(["24:00", "9:00", "12:60", "12:5", "noon", 900])("rejects %s", (value) => {
    expect(isTimeOfDay(value)).toBe(false);
  });
});

describe("mytDateString", () => {
  it("uses the MYT calendar day, not the UTC one", () => {
    expect(mytDateString(new Date("2026-12-24T15:59:59.999Z"))).toBe("2026-12-24");
    expect(mytDateString(new Date("2026-12-24T16:00:00.000Z"))).toBe("2026-12-25");
    expect(mytDateString(new Date("2026-12-31T16:00:00.000Z"))).toBe("2027-01-01");
  });

  it("agrees with Intl for Asia/Kuala_Lumpur across two years", () => {
    const intl = new Intl.DateTimeFormat("en-CA", {
      timeZone: MYT_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const start = Date.UTC(2026, 0, 1);
    for (let step = 0; step < 2600; step++) {
      const instant = new Date(start + step * 7 * MS_PER_HOUR + step * 61_000);
      expect(mytDateString(instant)).toBe(intl.format(instant));
    }
  });

  it("rejects an invalid Date", () => {
    expect(() => mytDateString(new Date("nope"))).toThrow(DomainError);
  });
});

describe("mytDateTime", () => {
  it("returns the instant of an MYT wall-clock time", () => {
    expect(mytDateTime("2026-12-24", "20:00").toISOString()).toBe("2026-12-24T12:00:00.000Z");
    expect(mytDateTime("2026-12-24", "07:30").toISOString()).toBe("2026-12-23T23:30:00.000Z");
  });

  it("defaults to midnight MYT", () => {
    expect(mytDateTime("2026-12-24").toISOString()).toBe("2026-12-23T16:00:00.000Z");
  });

  it("round-trips with mytDateString", () => {
    for (const date of ["2026-01-01", "2026-12-31", "2028-02-29"]) {
      expect(mytDateString(mytDateTime(date, "00:00"))).toBe(date);
      expect(mytDateString(mytDateTime(date, "23:59"))).toBe(date);
    }
  });

  it("rejects bad input", () => {
    expect(() => mytDateTime("2026-02-30", "10:00")).toThrow(DomainError);
    expect(() => mytDateTime("2026-12-24", "25:00")).toThrow(DomainError);
  });
});

describe("date arithmetic", () => {
  it("adds days across month, year and leap boundaries", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2027-02-28", 1)).toBe("2027-03-01");
    expect(addDays("2026-12-24", 0)).toBe("2026-12-24");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("rejects fractional days", () => {
    expect(() => addDays("2026-12-24", 0.5)).toThrow(DomainError);
  });

  it("counts whole days between dates", () => {
    expect(diffDays("2026-12-24", "2026-12-26")).toBe(2);
    expect(diffDays("2026-12-26", "2026-12-24")).toBe(-2);
    expect(diffDays("2026-12-24", "2026-12-24")).toBe(0);
  });

  it("lists every day in an inclusive range", () => {
    expect(eachDate("2026-12-30", "2027-01-02")).toEqual([
      "2026-12-30",
      "2026-12-31",
      "2027-01-01",
      "2027-01-02",
    ]);
    expect(eachDate("2026-12-24", "2026-12-24")).toEqual(["2026-12-24"]);
  });

  it("rejects reversed and runaway ranges", () => {
    expect(() => eachDate("2026-12-25", "2026-12-24")).toThrow(DomainError);
    expect(() => eachDate("2026-01-01", addDays("2026-01-01", MAX_DATE_RANGE_DAYS))).toThrow(
      DomainError,
    );
    expect(eachDate("2026-01-01", addDays("2026-01-01", MAX_DATE_RANGE_DAYS - 1))).toHaveLength(
      MAX_DATE_RANGE_DAYS,
    );
  });

  it("adds hours and minutes to instants", () => {
    const base = new Date("2026-12-24T12:00:00.000Z");
    expect(addHours(base, 12).toISOString()).toBe("2026-12-25T00:00:00.000Z");
    expect(addMinutes(base, -30).toISOString()).toBe("2026-12-24T11:30:00.000Z");
    expect(() => addHours(new Date(NaN), 1)).toThrow(DomainError);
    expect(() => addMinutes(new Date(NaN), 1)).toThrow(DomainError);
  });

  it("gives the day of week (0 = Sunday)", () => {
    expect(dayOfWeek("2026-12-24")).toBe(4); // Thursday
    expect(dayOfWeek("2026-11-10")).toBe(2); // Tuesday
    expect(dayOfWeek("2026-12-27")).toBe(0); // Sunday
  });
});

describe("formatting", () => {
  it("formats instants in MYT", () => {
    expect(formatMytDateTime(new Date("2026-12-24T12:30:00.000Z"), "en-GB")).toMatch(
      /24 Dec 2026.*20:30/,
    );
    // 17:00 UTC is already the next day in Malaysia.
    expect(formatMytDateTime(new Date("2026-12-24T17:00:00.000Z"), "en-GB")).toMatch(/25 Dec 2026/);
    expect(formatMytDateTime(new Date("2026-12-24T12:30:00.000Z"))).toContain("2026");
    expect(() => formatMytDateTime(new Date(NaN))).toThrow(DomainError);
  });

  it("formats calendar days", () => {
    expect(formatMytDate("2026-12-24", "en-GB")).toBe("24 Dec 2026");
    expect(formatMytDate("2026-12-24")).toContain("2026");
  });
});
