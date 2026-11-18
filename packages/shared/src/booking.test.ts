import { describe, expect, it } from "vitest";
import type { BookingField, PlanProblem } from "./booking";
import {
  MAX_BOOKING_DAYS_AHEAD,
  REF_CODE_ALPHABET,
  REF_CODE_PATTERN,
  holdRequestSchema,
  planBooking,
  quoteRequestSchema,
} from "./booking";
import { DEFAULT_SETTINGS } from "./defaultSettings";
import type { AllSettings } from "./schemas";
import { addDays, mytDateTime } from "./time";

const period = {
  pickupDate: "2026-12-24",
  pickupSlotId: "malam",
  pickupLocationId: "parit-buntar",
  returnDate: "2026-12-26",
  returnSlotId: "malam",
  returnLocationId: "parit-buntar",
};

const hold = {
  ...period,
  addOns: [{ code: "CPL", qty: 1 }],
  name: " Nur Aisyah ",
  phone: "017-491 3169",
  email: " Aisyah@Example.COM ",
  consent: { terms: true, privacy: true },
  turnstileToken: "t",
};

describe("quoteRequestSchema", () => {
  it("accepts a period with no add-ons and no phone", () => {
    expect(quoteRequestSchema.parse(period)).toEqual({ ...period, addOns: [] });
  });

  it("does not take a phone number (it would reveal the customer's tier)", () => {
    expect(quoteRequestSchema.safeParse({ ...period, phone: "0174913169" }).success).toBe(false);
  });

  it.each([
    ["an impossible date", { pickupDate: "2026-02-30" }],
    ["a slot id that is not a slug", { pickupSlotId: "Malam!" }],
    ["a client-sent price", { totalSen: 1 }],
    ["too many add-ons", { addOns: Array.from({ length: 11 }, () => ({ code: "CPL", qty: 1 })) }],
    ["a zero quantity", { addOns: [{ code: "CPL", qty: 0 }] }],
  ])("rejects %s", (_label, override) => {
    expect(quoteRequestSchema.safeParse({ ...period, ...override }).success).toBe(false);
  });
});

describe("holdRequestSchema", () => {
  it("normalises name, phone and email", () => {
    expect(holdRequestSchema.parse(hold)).toMatchObject({
      name: "Nur Aisyah",
      phone: "+60174913169",
      email: "aisyah@example.com",
    });
  });

  it.each([
    ["no consent to the terms", { consent: { terms: false, privacy: true } }],
    ["no consent to privacy", { consent: { terms: true, privacy: false } }],
    ["a bad email", { email: "not-an-email" }],
    ["a landline", { phone: "04-5931234" }],
    ["a one-letter name", { name: "A" }],
    ["no Turnstile token", { turnstileToken: "" }],
  ])("rejects %s", (_label, override) => {
    expect(holdRequestSchema.safeParse({ ...hold, ...override }).success).toBe(false);
  });
});

describe("reference codes", () => {
  it("avoid characters that are easy to confuse", () => {
    for (const confusing of ["0", "O", "1", "I", "L"]) {
      expect(REF_CODE_ALPHABET).not.toContain(confusing);
    }
    expect(REF_CODE_PATTERN.test("PK-7F3K9Q")).toBe(true);
    expect(REF_CODE_PATTERN.test("PK-7F3K0Q")).toBe(false);
  });
});

describe("planBooking", () => {
  // 2026-12-01 is a Tuesday.
  const now = mytDateTime("2026-12-01", "09:00");
  const settings: AllSettings = {
    ...DEFAULT_SETTINGS,
    handoverSlots: {
      slots: [
        {
          id: "pagi",
          label: "Pagi",
          daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
          startTime: "10:00",
          endTime: "11:00",
          kinds: ["pickup", "return"],
          locationIds: ["parit-buntar", "nibong-tebal"],
          active: true,
        },
        {
          id: "malam",
          label: "Malam",
          daysOfWeek: [5, 6],
          startTime: "20:00",
          endTime: "21:00",
          kinds: ["return"],
          locationIds: ["parit-buntar"],
          active: true,
        },
      ],
    },
  };
  const request = {
    pickupDate: "2026-12-10",
    pickupSlotId: "pagi",
    pickupLocationId: "parit-buntar",
    returnDate: "2026-12-12",
    returnSlotId: "pagi",
    returnLocationId: "parit-buntar",
    addOns: [{ code: "CPL", qty: 1 }],
  };

  it("prices the period and lists the days to lock, buffer included", () => {
    const plan = planBooking(request, settings, "new", now);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.rentalDays).toBe(2);
    expect(plan.value.pickup.start).toEqual(mytDateTime("2026-12-10", "10:00"));
    expect(plan.value.return.end).toEqual(mytDateTime("2026-12-12", "11:00"));
    // Return slot ends 11:00 on the 12th; the 12-hour buffer ends 23:00 the same day.
    expect(plan.value.lockedDates).toEqual(["2026-12-10", "2026-12-11", "2026-12-12"]);
    expect(plan.value.quote.breakdown).toMatchObject({
      rentalSen: 12000,
      addOnsSen: 500,
      depositSen: 10000,
      totalPayableSen: 22500,
    });
  });

  it.each<[string, Partial<typeof request>, BookingField, PlanProblem]>([
    [
      "an unknown pickup location",
      { pickupLocationId: "ipoh" },
      "pickupLocationId",
      "UNKNOWN_LOCATION",
    ],
    [
      "an unknown return location",
      { returnLocationId: "ipoh" },
      "returnLocationId",
      "UNKNOWN_LOCATION",
    ],
    ["an unknown pickup slot", { pickupSlotId: "tengahari" }, "pickupSlotId", "UNKNOWN_SLOT"],
    [
      "a return-only slot for pickup",
      { pickupSlotId: "malam" },
      "pickupSlotId",
      "SLOT_NOT_FOR_KIND",
    ],
    [
      "a slot on a day it does not run",
      { returnSlotId: "malam", returnDate: "2026-12-14" },
      "returnSlotId",
      "SLOT_NOT_ON_DAY",
    ],
    [
      "a pickup slot not served at the location",
      { pickupLocationId: "bandar-baharu" },
      "pickupLocationId",
      "LOCATION_NOT_SERVED",
    ],
    [
      "a return slot not served at the location",
      { returnSlotId: "malam", returnLocationId: "nibong-tebal" },
      "returnLocationId",
      "LOCATION_NOT_SERVED",
    ],
    ["an unknown return slot", { returnSlotId: "tengahari" }, "returnSlotId", "UNKNOWN_SLOT"],
    [
      "a return before pickup",
      { returnDate: "2026-12-09" },
      "returnDate",
      "RETURN_NOT_AFTER_PICKUP",
    ],
    [
      "a pickup inside the lead time",
      { pickupDate: "2026-12-01", returnDate: "2026-12-03" },
      "pickupDate",
      "LEAD_TIME_TOO_SHORT",
    ],
    [
      "a rental longer than the maximum",
      { returnDate: "2026-12-20" },
      "returnDate",
      "EXCEEDS_MAX_RENTAL_DAYS",
    ],
    ["an unknown add-on", { addOns: [{ code: "GIMBAL", qty: 1 }] }, "addOns", "INVALID_ADD_ONS"],
    ["too many of an add-on", { addOns: [{ code: "CPL", qty: 2 }] }, "addOns", "INVALID_ADD_ONS"],
  ])("rejects %s", (_label, override, field, problem) => {
    expect(planBooking({ ...request, ...override }, settings, "new", now)).toEqual({
      ok: false,
      field,
      problem,
    });
  });

  it("refuses pickups beyond the booking horizon", () => {
    const far = addDays("2026-12-01", MAX_BOOKING_DAYS_AHEAD + 1);
    expect(
      planBooking(
        { ...request, pickupDate: far, returnDate: addDays(far, 1) },
        settings,
        "new",
        now,
      ),
    ).toEqual({ ok: false, field: "pickupDate", problem: "TOO_FAR_AHEAD" });
  });

  it("rethrows errors that are not domain errors", () => {
    const broken = { ...settings, pricing: null } as unknown as AllSettings;
    expect(() => planBooking(request, broken, "new", now)).toThrow(TypeError);
  });
});
