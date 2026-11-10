import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "./defaultSettings";
import type { LateFeeSettings } from "./lateFee";
import { isOverdue, lateFeeSen } from "./lateFee";
import { MS_PER_HOUR, MS_PER_MINUTE, mytDateTime } from "./time";

const settings: LateFeeSettings = DEFAULT_SETTINGS.lateFee;
const slotEnd = mytDateTime("2026-12-06", "22:00");
const late = (ms: number) => new Date(slotEnd.getTime() + ms);

describe("isOverdue", () => {
  it("only becomes true once the grace period has fully passed", () => {
    expect(isOverdue(slotEnd, late(-1), 30)).toBe(false);
    expect(isOverdue(slotEnd, late(30 * MS_PER_MINUTE), 30)).toBe(false);
    expect(isOverdue(slotEnd, late(30 * MS_PER_MINUTE + 1), 30)).toBe(true);
  });
});

describe("lateFeeSen", () => {
  it.each([
    ["returned early", -MS_PER_HOUR, 0],
    ["exactly on time", 0, 0],
    ["exactly at the end of grace", 30 * MS_PER_MINUTE, 0],
    ["31 minutes late", 31 * MS_PER_MINUTE, 1500],
    ["exactly 6 hours late", 6 * MS_PER_HOUR, 1500],
    ["just over 6 hours late", 6 * MS_PER_HOUR + 1, 3000],
    ["12 hours late", 12 * MS_PER_HOUR, 3000],
    ["just over 18 hours late", 18 * MS_PER_HOUR + 1, 6000],
    ["exactly 24 hours late", 24 * MS_PER_HOUR, 6000],
    ["24 hours and a minute late", 24 * MS_PER_HOUR + MS_PER_MINUTE, 7500],
    ["48 hours late", 48 * MS_PER_HOUR, 12000],
  ])("%s", (_label, lateMs, expected) => {
    expect(lateFeeSen(slotEnd, late(lateMs), settings)).toBe(expected);
  });

  it("caps the charge for each 24 hours", () => {
    const capped: LateFeeSettings = { ...settings, capPer24hSen: 5000 };
    expect(lateFeeSen(slotEnd, late(18 * MS_PER_HOUR + 1), capped)).toBe(5000);
    expect(lateFeeSen(slotEnd, late(24 * MS_PER_HOUR), capped)).toBe(5000);
    expect(lateFeeSen(slotEnd, late(30 * MS_PER_HOUR), capped)).toBe(6500);
  });

  it("rejects settings that cannot be charged", () => {
    expect(() => lateFeeSen(slotEnd, late(MS_PER_HOUR), { ...settings, blockHours: 0 })).toThrow(
      expect.objectContaining({ code: "INVALID_SETTINGS" }),
    );
    expect(() =>
      lateFeeSen(slotEnd, late(MS_PER_HOUR), { ...settings, perBlockSen: 15.5 }),
    ).toThrow(expect.objectContaining({ code: "INVALID_AMOUNT" }));
    expect(() =>
      lateFeeSen(slotEnd, late(MS_PER_HOUR), { ...settings, capPer24hSen: NaN }),
    ).toThrow(expect.objectContaining({ code: "INVALID_AMOUNT" }));
  });
});
