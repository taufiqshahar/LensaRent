import type { AllSettings } from "./schemas";

/**
 * Initial `settings/*` values (master prompt §5). These seed a new environment and back the
 * tests; the live values are the Firestore documents, which an admin can change without a
 * deploy. Items marked TO CONFIRM are placeholders awaiting the business owner's decision.
 */
export const DEFAULT_SETTINGS: AllSettings = {
  pricing: {
    fixedPrices: [
      { days: 1, priceSen: 6900 },
      { days: 2, priceSen: 12000 },
      { days: 3, priceSen: 17000 },
    ],
    // 4 days and longer: 5000 × days.
    dailyRateSen: 5000,
  },
  addOns: {
    items: [
      // TO CONFIRM: RM5 is charged once per booking (not per day), one of each filter.
      {
        code: "CPL",
        name: "Penapis CPL",
        priceSen: 500,
        maxQty: 1,
        active: true,
        lensFilter: true,
      },
      {
        code: "VND_2_32",
        name: "Penapis VND 2-32",
        priceSen: 500,
        maxQty: 1,
        active: true,
        lensFilter: true,
      },
    ],
    lensFilterBase: { code: "MAGNETIC_FILTER_BASE", name: "Magnetic Filter Base" },
  },
  meetupLocations: {
    locations: [
      { id: "parit-buntar", name: "Parit Buntar", feeSen: 0, active: true },
      { id: "bandar-baharu", name: "Bandar Baharu", feeSen: 0, active: true },
      { id: "nibong-tebal", name: "Nibong Tebal", feeSen: 0, active: true },
    ],
  },
  // TO CONFIRM: the real handover schedule. Empty on purpose — it is not guessed.
  handoverSlots: { slots: [] },
  // Flat RM100 for every tier in the MVP; the tier is still recorded for risk and reports.
  depositTiers: { new: 10000, verified: 10000, returning: 10000 },
  buffer: { normalHours: 12, peakHours: 24 },
  peakPeriods: { periods: [] },
  // TO CONFIRM: how long an unpaid hold keeps its dates.
  holdMinutes: { minutes: 15 },
  minLeadHours: { hours: 24 },
  maxRentalDays: { days: 7 },
  // TO CONFIRM: the 24-hour cap is set to the one-day rental price.
  lateFee: { graceMinutes: 30, blockHours: 6, perBlockSen: 1500, capPer24hSen: 6900 },
  cancellation: { fullRefundAboveHours: 72, feeWindowFromHours: 24, feeSen: 3000 },
  policyVersions: { terms: "draf-0", privacy: "draf-0", rentalPolicy: "draf-0" },
  businessInfo: {
    brandName: "LensaRent",
    legalName: "",
    ssmNumber: "",
    address: "",
    phoneE164: "+60174913169",
    whatsappE164: "+60174913169",
    email: "",
  },
};
