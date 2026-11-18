import { describe, expect, it } from "vitest";
import type { HandoverSlot } from "./slots";
import { resolveSlot, slotsOn } from "./slots";

const slots: HandoverSlot[] = [
  {
    id: "malam",
    label: "Malam",
    daysOfWeek: [1, 2, 3, 4, 5],
    startTime: "20:00",
    endTime: "22:00",
    kinds: ["pickup", "return"],
    locationIds: ["parit-buntar"],
    active: true,
  },
  {
    id: "pagi-sabtu",
    label: "Pagi Sabtu",
    daysOfWeek: [6],
    startTime: "09:00",
    endTime: "11:00",
    kinds: ["pickup"],
    locationIds: ["parit-buntar", "nibong-tebal"],
    active: true,
  },
  {
    id: "tengah-hari",
    label: "Tengah hari",
    daysOfWeek: [4],
    startTime: "12:00",
    endTime: "13:00",
    kinds: ["pickup"],
    locationIds: ["parit-buntar"],
    active: true,
  },
  {
    id: "lama",
    label: "Lama",
    daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
    startTime: "07:00",
    endTime: "08:00",
    kinds: ["pickup", "return"],
    locationIds: ["parit-buntar"],
    active: false,
  },
];

describe("slotsOn", () => {
  it("lists the active slots for the day and kind, earliest first", () => {
    expect(slotsOn(slots, "2026-12-24", "pickup").map((slot) => slot.id)).toEqual([
      "tengah-hari",
      "malam",
    ]); // Thursday
    expect(slotsOn(slots, "2026-12-26", "pickup").map((slot) => slot.id)).toEqual(["pagi-sabtu"]); // Saturday
    expect(slotsOn(slots, "2026-12-26", "return")).toEqual([]);
    expect(slotsOn(slots, "2026-12-27", "pickup")).toEqual([]); // Sunday: only the inactive slot
  });
});

describe("resolveSlot", () => {
  it("returns the slot's real start and end in Malaysia time", () => {
    const result = resolveSlot(slots, {
      date: "2026-12-24",
      slotId: "malam",
      kind: "pickup",
      locationId: "parit-buntar",
    });
    expect(result.ok && result.value.start.toISOString()).toBe("2026-12-24T12:00:00.000Z");
    expect(result.ok && result.value.end.toISOString()).toBe("2026-12-24T14:00:00.000Z");
  });

  it.each([
    ["an unknown slot", { slotId: "tiada" }, "UNKNOWN_SLOT"],
    ["an inactive slot", { slotId: "lama" }, "UNKNOWN_SLOT"],
    [
      "a pickup-only slot used for return",
      { slotId: "pagi-sabtu", date: "2026-12-26", kind: "return" as const },
      "SLOT_NOT_FOR_KIND",
    ],
    ["a weekday slot on Saturday", { date: "2026-12-26" }, "SLOT_NOT_ON_DAY"],
    ["a location the slot does not serve", { locationId: "nibong-tebal" }, "LOCATION_NOT_SERVED"],
  ])("refuses %s", (_label, override, problem) => {
    expect(
      resolveSlot(slots, {
        date: "2026-12-24",
        slotId: "malam",
        kind: "pickup",
        locationId: "parit-buntar",
        ...override,
      }),
    ).toEqual({ ok: false, problem });
  });
});
