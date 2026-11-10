import { DomainError } from "./errors";
import type { Sen } from "./money";
import { assertSen, multiplySen, sumSen } from "./money";

/**
 * Pricing is computed on the server from `settings/*` values only. Nothing here is
 * hard-coded business data, and prices sent by a client are never trusted.
 */
export interface PricingSettings {
  /** Package prices for short rentals, contiguous from 1 day (e.g. 1, 2, 3 days). */
  fixedPrices: readonly { days: number; priceSen: Sen }[];
  /** Per-day rate for rentals longer than the last fixed price: `dailyRateSen × days`. */
  dailyRateSen: Sen;
}

export interface AddOnDefinition {
  code: string;
  name: string;
  /** Price per unit, charged once per booking. */
  priceSen: Sen;
  maxQty: number;
  active: boolean;
  /** Lens filters need the magnetic filter base, which is then included for free. */
  lensFilter: boolean;
}

export interface IncludedItem {
  code: string;
  name: string;
}

export interface AddOnsSettings {
  items: readonly AddOnDefinition[];
  /** Included automatically, at no charge, whenever any lens filter is selected. */
  lensFilterBase: IncludedItem;
}

export interface MeetupLocation {
  id: string;
  name: string;
  feeSen: Sen;
  active: boolean;
}

export const CUSTOMER_TIERS = ["new", "verified", "returning"] as const;
export type CustomerTier = (typeof CUSTOMER_TIERS)[number];
export type DepositTiers = Record<CustomerTier, Sen>;

export interface QuoteSettings {
  pricing: PricingSettings;
  addOns: AddOnsSettings;
  meetupLocations: { locations: readonly MeetupLocation[] };
  depositTiers: DepositTiers;
  maxRentalDays: { days: number };
}

export interface QuoteInput {
  rentalDays: number;
  addOns: readonly { code: string; qty: number }[];
  pickupLocationId: string;
  returnLocationId: string;
  customerTier: CustomerTier;
  /** Discount on the rental charges (never on the deposit). Defaults to 0. */
  discountSen?: Sen | undefined;
}

export interface AddOnLine {
  code: string;
  name: string;
  qty: number;
  unitPriceSen: Sen;
  totalSen: Sen;
}

export interface PriceBreakdown {
  rentalSen: Sen;
  addOnsSen: Sen;
  meetupSen: Sen;
  discountSen: Sen;
  /** Security deposit: a refundable liability, never revenue. Always shown separately. */
  depositSen: Sen;
  totalPayableSen: Sen;
}

export interface Quote {
  rentalDays: number;
  addOnLines: AddOnLine[];
  includedItems: IncludedItem[];
  breakdown: PriceBreakdown;
}

export function rentalPriceSen(days: number, pricing: PricingSettings, maxRentalDays: number): Sen {
  if (!Number.isSafeInteger(days) || days < 1) {
    throw new DomainError("INVALID_RENTAL_DAYS", "rental days must be a positive integer");
  }
  if (days > maxRentalDays) {
    throw new DomainError("EXCEEDS_MAX_RENTAL_DAYS", "rental is longer than the allowed maximum");
  }
  const fixed = pricing.fixedPrices.find((entry) => entry.days === days);
  return fixed ? fixed.priceSen : multiplySen(pricing.dailyRateSen, days);
}

function priceAddOns(
  selected: QuoteInput["addOns"],
  settings: AddOnsSettings,
): { lines: AddOnLine[]; includedItems: IncludedItem[] } {
  const seen = new Set<string>();
  const lines: AddOnLine[] = [];
  let needsFilterBase = false;

  for (const { code, qty } of selected) {
    if (seen.has(code)) {
      throw new DomainError("DUPLICATE_ADD_ON", "an add-on was listed more than once");
    }
    seen.add(code);

    const definition = settings.items.find((item) => item.code === code && item.active);
    if (!definition) throw new DomainError("UNKNOWN_ADD_ON", "add-on is not available");
    if (!Number.isSafeInteger(qty) || qty < 1) {
      throw new DomainError("INVALID_ADD_ON_QTY", "add-on quantity must be a positive integer");
    }
    if (qty > definition.maxQty) {
      throw new DomainError("ADD_ON_QTY_EXCEEDED", "add-on quantity is above the allowed maximum");
    }

    needsFilterBase ||= definition.lensFilter;
    lines.push({
      code,
      name: definition.name,
      qty,
      unitPriceSen: definition.priceSen,
      totalSen: multiplySen(definition.priceSen, qty),
    });
  }

  return { lines, includedItems: needsFilterBase ? [{ ...settings.lensFilterBase }] : [] };
}

function meetupFeeSen(locationId: string, locations: readonly MeetupLocation[]): Sen {
  const location = locations.find((entry) => entry.id === locationId && entry.active);
  if (!location) throw new DomainError("UNKNOWN_LOCATION", "meetup location is not available");
  return location.feeSen;
}

/** Full price for a booking. The deposit is added on top and reported separately. */
export function quote(input: QuoteInput, settings: QuoteSettings): Quote {
  const rentalSen = rentalPriceSen(input.rentalDays, settings.pricing, settings.maxRentalDays.days);

  const { lines, includedItems } = priceAddOns(input.addOns, settings.addOns);
  const addOnsSen = sumSen(lines.map((line) => line.totalSen));

  // Pickup and return are separate trips, so each location's fee applies once.
  const meetupSen = sumSen([
    meetupFeeSen(input.pickupLocationId, settings.meetupLocations.locations),
    meetupFeeSen(input.returnLocationId, settings.meetupLocations.locations),
  ]);

  const chargesSen = sumSen([rentalSen, addOnsSen, meetupSen]);
  const discountSen = input.discountSen ?? 0;
  assertSen(discountSen, "discount");
  if (discountSen < 0 || discountSen > chargesSen) {
    throw new DomainError("INVALID_DISCOUNT", "discount must be between 0 and the rental charges");
  }

  const depositSen = settings.depositTiers[input.customerTier];
  assertSen(depositSen, "deposit");

  return {
    rentalDays: input.rentalDays,
    addOnLines: lines,
    includedItems,
    breakdown: {
      rentalSen,
      addOnsSen,
      meetupSen,
      discountSen,
      depositSen,
      totalPayableSen: chargesSen - discountSen + depositSen,
    },
  };
}
