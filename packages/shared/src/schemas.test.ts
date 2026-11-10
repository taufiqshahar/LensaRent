import { describe, expect, it } from "vitest";
import type { BufferSettings } from "./duration";
import { DEFAULT_SETTINGS } from "./defaultSettings";
import {
  SETTINGS_KEYS,
  actorTypeSchema,
  bookingStatusSchema,
  customerTierSchema,
  dateStringSchema,
  isSettingsKey,
  ledgerEntryTypeSchema,
  lockKindSchema,
  nonNegativeSenSchema,
  parseSettingsValue,
  phoneE164Schema,
  positiveSenSchema,
  senSchema,
  timeOfDaySchema,
  unitStatusSchema,
} from "./schemas";

describe("settings keys", () => {
  it("are exactly the keys in the specification", () => {
    expect([...SETTINGS_KEYS].sort()).toEqual(
      [
        "pricing",
        "addOns",
        "meetupLocations",
        "handoverSlots",
        "depositTiers",
        "buffer",
        "peakPeriods",
        "holdMinutes",
        "minLeadHours",
        "maxRentalDays",
        "lateFee",
        "cancellation",
        "policyVersions",
        "businessInfo",
      ].sort(),
    );
  });

  it("are recognised without trusting inherited object properties", () => {
    expect(isSettingsKey("pricing")).toBe(true);
    expect(isSettingsKey("toString")).toBe(false);
    expect(isSettingsKey("__proto__")).toBe(false);
    expect(isSettingsKey("secrets")).toBe(false);
  });
});

describe("DEFAULT_SETTINGS", () => {
  it.each(SETTINGS_KEYS)("%s is valid and unchanged by parsing", (key) => {
    expect(parseSettingsValue(key, DEFAULT_SETTINGS[key])).toEqual(DEFAULT_SETTINGS[key]);
  });

  it("carries the initial business values", () => {
    expect(DEFAULT_SETTINGS.depositTiers).toEqual({
      new: 10000,
      verified: 10000,
      returning: 10000,
    });
    expect(DEFAULT_SETTINGS.minLeadHours.hours).toBe(24);
    expect(DEFAULT_SETTINGS.maxRentalDays.days).toBe(7);
    const buffer: BufferSettings = DEFAULT_SETTINGS.buffer;
    expect(buffer).toEqual({ normalHours: 12, peakHours: 24 });
    expect(DEFAULT_SETTINGS.meetupLocations.locations.map((location) => location.name)).toEqual([
      "Parit Buntar",
      "Bandar Baharu",
      "Nibong Tebal",
    ]);
  });
});

describe("settings validation", () => {
  const invalid: [string, Parameters<typeof parseSettingsValue>[0], unknown][] = [
    [
      "pricing with a gap in days",
      "pricing",
      {
        fixedPrices: [
          { days: 1, priceSen: 6900 },
          { days: 3, priceSen: 17000 },
        ],
        dailyRateSen: 5000,
      },
    ],
    [
      "pricing with a float price",
      "pricing",
      { fixedPrices: [{ days: 1, priceSen: 69.5 }], dailyRateSen: 5000 },
    ],
    [
      "pricing with a zero daily rate",
      "pricing",
      { fixedPrices: [{ days: 1, priceSen: 6900 }], dailyRateSen: 0 },
    ],
    ["pricing with no fixed prices", "pricing", { fixedPrices: [], dailyRateSen: 5000 }],
    [
      "add-ons with a repeated code",
      "addOns",
      {
        ...DEFAULT_SETTINGS.addOns,
        items: [DEFAULT_SETTINGS.addOns.items[0], DEFAULT_SETTINGS.addOns.items[0]],
      },
    ],
    [
      "add-ons with a lower-case code",
      "addOns",
      { ...DEFAULT_SETTINGS.addOns, items: [{ ...DEFAULT_SETTINGS.addOns.items[0], code: "cpl" }] },
    ],
    [
      "add-ons with a negative price",
      "addOns",
      {
        ...DEFAULT_SETTINGS.addOns,
        items: [{ ...DEFAULT_SETTINGS.addOns.items[0], priceSen: -1 }],
      },
    ],
    ["no meetup locations", "meetupLocations", { locations: [] }],
    [
      "repeated location ids",
      "meetupLocations",
      {
        locations: [
          DEFAULT_SETTINGS.meetupLocations.locations[0],
          DEFAULT_SETTINGS.meetupLocations.locations[0],
        ],
      },
    ],
    [
      "a peak period that ends before it starts",
      "peakPeriods",
      { periods: [{ from: "2026-12-26", to: "2026-12-24" }] },
    ],
    [
      "a peak period with an impossible date",
      "peakPeriods",
      { periods: [{ from: "2026-02-30", to: "2026-03-01" }] },
    ],
    ["a zero-minute hold", "holdMinutes", { minutes: 0 }],
    ["a negative lead time", "minLeadHours", { hours: -1 }],
    ["rentals longer than 30 days", "maxRentalDays", { days: 31 }],
    ["a fractional deposit", "depositTiers", { new: 100.5, verified: 10000, returning: 10000 }],
    ["a buffer longer than a week", "buffer", { normalHours: 12, peakHours: 200 }],
    ["a zero-length late fee block", "lateFee", { ...DEFAULT_SETTINGS.lateFee, blockHours: 0 }],
    [
      "a fee window wider than the full-refund line",
      "cancellation",
      { fullRefundAboveHours: 24, feeWindowFromHours: 72, feeSen: 3000 },
    ],
    ["an empty policy version", "policyVersions", { terms: "", privacy: "v1", rentalPolicy: "v1" }],
    [
      "a local-format phone number",
      "businessInfo",
      { ...DEFAULT_SETTINGS.businessInfo, phoneE164: "0174913169" },
    ],
    [
      "a malformed email",
      "businessInfo",
      { ...DEFAULT_SETTINGS.businessInfo, email: "not-an-email" },
    ],
    ["a missing value", "pricing", undefined],
  ];

  it.each(invalid)("rejects %s", (_label, key, value) => {
    expect(() => parseSettingsValue(key, value)).toThrow();
  });

  it("accepts a real email in business info", () => {
    const value = { ...DEFAULT_SETTINGS.businessInfo, email: "admin@example.com" };
    expect(parseSettingsValue("businessInfo", value)).toEqual(value);
  });

  describe("handover slots", () => {
    const slot = {
      id: "malam-hari-bekerja",
      label: "Malam hari bekerja",
      daysOfWeek: [1, 2, 3, 4, 5],
      startTime: "20:00",
      endTime: "22:00",
      kinds: ["pickup", "return"],
      locationIds: ["parit-buntar"],
      active: true,
    };

    it("accepts a well-formed schedule", () => {
      expect(parseSettingsValue("handoverSlots", { slots: [slot] })).toEqual({ slots: [slot] });
    });

    it.each([
      ["a slot that ends before it starts", { ...slot, endTime: "19:00" }],
      ["a slot with a repeated weekday", { ...slot, daysOfWeek: [1, 1] }],
      ["a slot with an impossible weekday", { ...slot, daysOfWeek: [7] }],
      ["a slot with a bad time", { ...slot, startTime: "8pm" }],
      ["a slot with no kind", { ...slot, kinds: [] }],
      ["a slot with no location", { ...slot, locationIds: [] }],
    ])("rejects %s", (_label, bad) => {
      expect(() => parseSettingsValue("handoverSlots", { slots: [bad] })).toThrow();
    });

    it("rejects repeated slot ids", () => {
      expect(() => parseSettingsValue("handoverSlots", { slots: [slot, slot] })).toThrow();
    });
  });
});

describe("primitive schemas", () => {
  it("keep money as integers", () => {
    expect(senSchema.parse(-3000)).toBe(-3000);
    expect(() => senSchema.parse(1.5)).toThrow();
    expect(() => senSchema.parse("100")).toThrow();
    expect(nonNegativeSenSchema.parse(0)).toBe(0);
    expect(() => nonNegativeSenSchema.parse(-1)).toThrow();
    expect(positiveSenSchema.parse(1)).toBe(1);
    expect(() => positiveSenSchema.parse(0)).toThrow();
  });

  it("validate dates, times and phone numbers", () => {
    expect(dateStringSchema.parse("2026-12-24")).toBe("2026-12-24");
    expect(() => dateStringSchema.parse("2026-02-30")).toThrow();
    expect(timeOfDaySchema.parse("20:00")).toBe("20:00");
    expect(() => timeOfDaySchema.parse("24:00")).toThrow();
    expect(phoneE164Schema.parse("+60174913169")).toBe("+60174913169");
    expect(() => phoneE164Schema.parse("+0174913169")).toThrow();
  });

  it("accept only known enumeration values", () => {
    expect(bookingStatusSchema.parse("pending_payment")).toBe("pending_payment");
    expect(() => bookingStatusSchema.parse("paid")).toThrow();
    expect(actorTypeSchema.parse("webhook")).toBe("webhook");
    expect(() => actorTypeSchema.parse("customer")).toThrow();
    expect(ledgerEntryTypeSchema.parse("DEPOSIT_IN")).toBe("DEPOSIT_IN");
    expect(() => ledgerEntryTypeSchema.parse("TIP")).toThrow();
    expect(customerTierSchema.parse("returning")).toBe("returning");
    expect(() => customerTierSchema.parse("vip")).toThrow();
    expect(unitStatusSchema.parse("maintenance")).toBe("maintenance");
    expect(() => unitStatusSchema.parse("lost")).toThrow();
    expect(lockKindSchema.parse("hold")).toBe("hold");
    expect(() => lockKindSchema.parse("soft")).toThrow();
  });
});
