import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "./defaultSettings";
import type { QuoteInput, QuoteSettings } from "./pricing";
import { quote, rentalPriceSen } from "./pricing";

const settings: QuoteSettings = DEFAULT_SETTINGS;

const baseInput: QuoteInput = {
  rentalDays: 1,
  addOns: [],
  pickupLocationId: "parit-buntar",
  returnLocationId: "parit-buntar",
  customerTier: "new",
};

describe("rentalPriceSen", () => {
  it.each([
    [1, 6900],
    [2, 12000],
    [3, 17000],
    [4, 20000],
    [5, 25000],
    [6, 30000],
    [7, 35000],
  ])("%d day(s) costs %d sen", (days, expected) => {
    expect(rentalPriceSen(days, settings.pricing, 7)).toBe(expected);
  });

  it.each([0, -1, 1.5, NaN])("rejects %d days", (days) => {
    expect(() => rentalPriceSen(days, settings.pricing, 7)).toThrow(
      expect.objectContaining({ code: "INVALID_RENTAL_DAYS" }),
    );
  });

  it("rejects rentals longer than the maximum", () => {
    expect(() => rentalPriceSen(8, settings.pricing, 7)).toThrow(
      expect.objectContaining({ code: "EXCEEDS_MAX_RENTAL_DAYS" }),
    );
  });
});

describe("quote", () => {
  it("prices a plain one-day rental and reports the deposit separately", () => {
    expect(quote(baseInput, settings)).toEqual({
      rentalDays: 1,
      addOnLines: [],
      includedItems: [],
      breakdown: {
        rentalSen: 6900,
        addOnsSen: 0,
        meetupSen: 0,
        discountSen: 0,
        depositSen: 10000,
        totalPayableSen: 16900,
      },
    });
  });

  it("adds lens filters and includes the magnetic base once, for free", () => {
    const result = quote(
      {
        ...baseInput,
        rentalDays: 3,
        addOns: [
          { code: "CPL", qty: 1 },
          { code: "VND_2_32", qty: 1 },
        ],
      },
      settings,
    );
    expect(result.addOnLines).toEqual([
      { code: "CPL", name: "Penapis CPL", qty: 1, unitPriceSen: 500, totalSen: 500 },
      { code: "VND_2_32", name: "Penapis VND 2-32", qty: 1, unitPriceSen: 500, totalSen: 500 },
    ]);
    expect(result.includedItems).toEqual([
      { code: "MAGNETIC_FILTER_BASE", name: "Magnetic Filter Base" },
    ]);
    expect(result.breakdown).toMatchObject({
      rentalSen: 17000,
      addOnsSen: 1000,
      depositSen: 10000,
      totalPayableSen: 28000,
    });
  });

  it("returns a copy of the included item, not the settings object", () => {
    const result = quote({ ...baseInput, addOns: [{ code: "CPL", qty: 1 }] }, settings);
    expect(result.includedItems[0]).not.toBe(settings.addOns.lensFilterBase);
  });

  it("does not include the filter base for add-ons that are not lens filters", () => {
    const custom: QuoteSettings = {
      ...settings,
      addOns: {
        ...settings.addOns,
        items: [
          {
            code: "TRIPOD",
            name: "Tripod",
            priceSen: 800,
            maxQty: 3,
            active: true,
            lensFilter: false,
          },
        ],
      },
    };
    const result = quote({ ...baseInput, addOns: [{ code: "TRIPOD", qty: 3 }] }, custom);
    expect(result.includedItems).toEqual([]);
    expect(result.breakdown.addOnsSen).toBe(2400);
  });

  it.each([
    ["an unknown add-on", [{ code: "DRONE", qty: 1 }], "UNKNOWN_ADD_ON"],
    ["a quantity above the maximum", [{ code: "CPL", qty: 2 }], "ADD_ON_QTY_EXCEEDED"],
    ["a zero quantity", [{ code: "CPL", qty: 0 }], "INVALID_ADD_ON_QTY"],
    ["a fractional quantity", [{ code: "CPL", qty: 0.5 }], "INVALID_ADD_ON_QTY"],
    [
      "a duplicated add-on",
      [
        { code: "CPL", qty: 1 },
        { code: "CPL", qty: 1 },
      ],
      "DUPLICATE_ADD_ON",
    ],
  ])("rejects %s", (_label, addOns, code) => {
    expect(() => quote({ ...baseInput, addOns }, settings)).toThrow(
      expect.objectContaining({ code }),
    );
  });

  it("rejects an inactive add-on", () => {
    const custom: QuoteSettings = {
      ...settings,
      addOns: {
        ...settings.addOns,
        items: settings.addOns.items.map((item) => ({ ...item, active: false })),
      },
    };
    expect(() => quote({ ...baseInput, addOns: [{ code: "CPL", qty: 1 }] }, custom)).toThrow(
      expect.objectContaining({ code: "UNKNOWN_ADD_ON" }),
    );
  });

  describe("meetup fees", () => {
    const withFees: QuoteSettings = {
      ...settings,
      meetupLocations: {
        locations: [
          { id: "parit-buntar", name: "Parit Buntar", feeSen: 0, active: true },
          { id: "nibong-tebal", name: "Nibong Tebal", feeSen: 1000, active: true },
          { id: "closed", name: "Tutup", feeSen: 0, active: false },
        ],
      },
    };

    it("charges each trip's location fee", () => {
      const oneWay = quote({ ...baseInput, returnLocationId: "nibong-tebal" }, withFees);
      expect(oneWay.breakdown.meetupSen).toBe(1000);
      const both = quote(
        { ...baseInput, pickupLocationId: "nibong-tebal", returnLocationId: "nibong-tebal" },
        withFees,
      );
      expect(both.breakdown.meetupSen).toBe(2000);
      expect(both.breakdown.totalPayableSen).toBe(6900 + 2000 + 10000);
    });

    it.each(["nowhere", "closed"])("rejects location %s", (locationId) => {
      expect(() => quote({ ...baseInput, pickupLocationId: locationId }, withFees)).toThrow(
        expect.objectContaining({ code: "UNKNOWN_LOCATION" }),
      );
      expect(() => quote({ ...baseInput, returnLocationId: locationId }, withFees)).toThrow(
        expect.objectContaining({ code: "UNKNOWN_LOCATION" }),
      );
    });
  });

  describe("discount", () => {
    it("reduces the charges but never the deposit", () => {
      expect(quote({ ...baseInput, discountSen: 1000 }, settings).breakdown).toMatchObject({
        discountSen: 1000,
        totalPayableSen: 15900,
      });
      expect(quote({ ...baseInput, discountSen: 6900 }, settings).breakdown.totalPayableSen).toBe(
        10000,
      );
    });

    it.each([
      [6901, "INVALID_DISCOUNT"],
      [-1, "INVALID_DISCOUNT"],
      [10.5, "INVALID_AMOUNT"],
    ])("rejects a discount of %d", (discountSen, code) => {
      expect(() => quote({ ...baseInput, discountSen }, settings)).toThrow(
        expect.objectContaining({ code }),
      );
    });
  });

  describe("deposit", () => {
    it("is flat RM100 for every tier by default", () => {
      for (const customerTier of ["new", "verified", "returning"] as const) {
        expect(quote({ ...baseInput, customerTier }, settings).breakdown.depositSen).toBe(10000);
      }
    });

    it("follows the tier table when it is changed in settings", () => {
      const custom: QuoteSettings = {
        ...settings,
        depositTiers: { new: 20000, verified: 10000, returning: 5000 },
      };
      expect(quote({ ...baseInput, customerTier: "returning" }, custom).breakdown).toMatchObject({
        depositSen: 5000,
        totalPayableSen: 11900,
      });
    });
  });
});
