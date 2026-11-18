import { DEFAULT_SETTINGS } from "@lensarent/shared";
import { describe, expect, it } from "vitest";
import { createLogger } from "../../src/lib/logger";
import { loadSettings } from "../../src/lib/settings";

/** A D1 stand-in that answers the settings query with fixed rows. */
function fakeDb(rows: { key: string; value: string }[]): D1Database {
  return {
    prepare: () => ({ bind: () => ({ all: () => Promise.resolve({ results: rows }) }) }),
  } as unknown as D1Database;
}

describe("loadSettings", () => {
  it("returns the code defaults when nothing is stored", async () => {
    expect(await loadSettings(fakeDb([]))).toEqual(DEFAULT_SETTINGS);
  });

  it("overlays valid admin-edited keys and ignores invalid or foreign rows", async () => {
    const lines: string[] = [];
    const logger = createLogger({ environment: "test", sink: (_level, line) => lines.push(line) });
    const settings = await loadSettings(
      fakeDb([
        { key: "holdMinutes", value: JSON.stringify({ minutes: 20 }) },
        { key: "minLeadHours", value: JSON.stringify({ hours: -1 }) },
        { key: "buffer", value: "not json" },
        { key: "pricing", value: JSON.stringify({ fixedPrices: [], dailyRateSen: 1 }) },
      ]),
      logger,
    );
    expect(settings.holdMinutes).toEqual({ minutes: 20 });
    expect(settings.minLeadHours).toEqual(DEFAULT_SETTINGS.minLeadHours);
    expect(settings.buffer).toEqual(DEFAULT_SETTINGS.buffer);
    expect(settings.pricing).toEqual(DEFAULT_SETTINGS.pricing);
    expect(lines.filter((line) => line.includes("settings.invalid_row"))).toHaveLength(2);
    // The defaults themselves are never mutated.
    expect(DEFAULT_SETTINGS.holdMinutes).toEqual({ minutes: 15 });
  });
});
