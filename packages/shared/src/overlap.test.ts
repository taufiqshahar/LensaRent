import { describe, expect, it } from "vitest";
import { DomainError } from "./errors";
import { conflictingDates, dateRangesOverlap, intervalsOverlap } from "./overlap";

describe("dateRangesOverlap (inclusive days)", () => {
  const range = (from: string, to: string) => ({ from, to });

  it.each([
    [
      "identical ranges",
      range("2026-12-24", "2026-12-26"),
      range("2026-12-24", "2026-12-26"),
      true,
    ],
    [
      "a shared boundary day",
      range("2026-12-24", "2026-12-26"),
      range("2026-12-26", "2026-12-28"),
      true,
    ],
    ["adjacent days", range("2026-12-24", "2026-12-26"), range("2026-12-27", "2026-12-28"), false],
    [
      "one inside the other",
      range("2026-12-20", "2026-12-30"),
      range("2026-12-24", "2026-12-25"),
      true,
    ],
    ["fully separate", range("2026-12-01", "2026-12-02"), range("2026-12-24", "2026-12-25"), false],
    [
      "single-day ranges on the same day",
      range("2026-12-24", "2026-12-24"),
      range("2026-12-24", "2026-12-24"),
      true,
    ],
  ])("%s", (_label, a, b, expected) => {
    expect(dateRangesOverlap(a, b)).toBe(expected);
    expect(dateRangesOverlap(b, a)).toBe(expected);
  });

  it("rejects a range that ends before it starts", () => {
    const good = range("2026-12-24", "2026-12-26");
    const bad = range("2026-12-26", "2026-12-24");
    expect(() => dateRangesOverlap(bad, good)).toThrow(DomainError);
    expect(() => dateRangesOverlap(good, bad)).toThrow(DomainError);
  });
});

describe("intervalsOverlap (half-open)", () => {
  const interval = (start: string, end: string) => ({ start: new Date(start), end: new Date(end) });

  it.each([
    [
      "touching end-to-start",
      interval("2026-12-24T00:00Z", "2026-12-24T10:00Z"),
      interval("2026-12-24T10:00Z", "2026-12-24T12:00Z"),
      false,
    ],
    [
      "a one-millisecond overlap",
      interval("2026-12-24T00:00Z", "2026-12-24T10:00:00.001Z"),
      interval("2026-12-24T10:00Z", "2026-12-24T12:00Z"),
      true,
    ],
    [
      "one inside the other",
      interval("2026-12-24T00:00Z", "2026-12-25T00:00Z"),
      interval("2026-12-24T10:00Z", "2026-12-24T11:00Z"),
      true,
    ],
    [
      "fully separate",
      interval("2026-12-24T00:00Z", "2026-12-24T01:00Z"),
      interval("2026-12-25T00:00Z", "2026-12-25T01:00Z"),
      false,
    ],
  ])("%s", (_label, a, b, expected) => {
    expect(intervalsOverlap(a, b)).toBe(expected);
    expect(intervalsOverlap(b, a)).toBe(expected);
  });
});

describe("conflictingDates", () => {
  it("returns the wanted days that are taken, in the order asked", () => {
    const wanted = ["2026-12-24", "2026-12-25", "2026-12-26"];
    expect(conflictingDates(wanted, new Set(["2026-12-26", "2026-12-24", "2026-11-01"]))).toEqual([
      "2026-12-24",
      "2026-12-26",
    ]);
    expect(conflictingDates(wanted, ["2026-12-27"])).toEqual([]);
    expect(conflictingDates([], ["2026-12-27"])).toEqual([]);
  });
});
