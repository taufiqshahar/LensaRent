import { z } from "zod";
import { validateRentalPeriod, lockedDates, rentalDays } from "./duration";
import { DomainError } from "./errors";
import type { CustomerTier, Quote } from "./pricing";
import { quote } from "./pricing";
import type { AllSettings } from "./schemas";
import { normalizeMyMobile } from "./phone";
import { codeSchema, dateStringSchema, slugSchema } from "./schemas";
import type { ResolvedSlot } from "./slots";
import { resolveSlot } from "./slots";
import type { DateString } from "./time";
import { addDays, mytDateString } from "./time";

/**
 * What the booking wizard sends. Prices are never sent: the server computes them from the
 * settings. Unknown fields are rejected.
 */
const NO_CONTROL_CHARS = /^[^\p{Cc}]*$/u;

const periodFields = {
  pickupDate: dateStringSchema,
  pickupSlotId: slugSchema,
  pickupLocationId: slugSchema,
  returnDate: dateStringSchema,
  returnSlotId: slugSchema,
  returnLocationId: slugSchema,
  addOns: z
    .array(z.strictObject({ code: codeSchema, qty: z.int().min(1).max(10) }))
    .max(10)
    .default([]),
};

const phoneField = z
  .string()
  .max(30)
  .transform((value, context) => {
    const e164 = normalizeMyMobile(value);
    if (e164 === null) {
      context.addIssue({ code: "custom", message: "not a Malaysian mobile number" });
      return z.NEVER;
    }
    return e164;
  });

/**
 * POST /api/quote — price a period before the customer commits. It takes no phone number:
 * answering with a customer's tier would tell anyone whether a number has rented before.
 * The quote uses the `new` tier; the hold charges the customer's real tier.
 */
export const quoteRequestSchema = z.strictObject(periodFields);
export type QuoteRequest = z.infer<typeof quoteRequestSchema>;

/** POST /api/bookings/hold — reserve the dates and start payment. */
export const holdRequestSchema = z.strictObject({
  ...periodFields,
  name: z.string().trim().min(2).max(80).regex(NO_CONTROL_CHARS),
  phone: phoneField,
  // CHIP requires an email for every purchase; the receipt goes there too.
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
  consent: z.strictObject({ terms: z.literal(true), privacy: z.literal(true) }),
  turnstileToken: z.string().min(1).max(2048),
});
export type HoldRequest = z.infer<typeof holdRequestSchema>;

/** Public booking reference, e.g. PK-7F3K9Q. No 0/O, 1/I/L. */
export const REF_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const REF_CODE_PATTERN = /^PK-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/;

/**
 * How far ahead a booking may start. A technical bound that keeps lock batches and the
 * availability calendar small, not a business rule; the owner may ask to shorten it.
 */
export const MAX_BOOKING_DAYS_AHEAD = 365;

export type BookingField =
  | "pickupDate"
  | "pickupSlotId"
  | "pickupLocationId"
  | "returnDate"
  | "returnSlotId"
  | "returnLocationId"
  | "addOns";

export type PlanProblem =
  | "UNKNOWN_SLOT"
  | "SLOT_NOT_FOR_KIND"
  | "SLOT_NOT_ON_DAY"
  | "LOCATION_NOT_SERVED"
  | "UNKNOWN_LOCATION"
  | "RETURN_NOT_AFTER_PICKUP"
  | "LEAD_TIME_TOO_SHORT"
  | "TOO_FAR_AHEAD"
  | "EXCEEDS_MAX_RENTAL_DAYS"
  | "INVALID_ADD_ONS";

export interface BookingPlan {
  pickup: ResolvedSlot;
  return: ResolvedSlot;
  rentalDays: number;
  lockedDates: DateString[];
  quote: Quote;
}

export type PlanResult =
  { ok: true; value: BookingPlan } | { ok: false; field: BookingField; problem: PlanProblem };

/**
 * Turns a validated quote/hold request into instants, billable days, the calendar days to
 * lock and the price — or the first problem, named by the field the customer must change.
 * Pure: the same input always gives the same plan, so quote and hold cannot disagree.
 */
export function planBooking(
  request: z.infer<typeof quoteRequestSchema>,
  settings: AllSettings,
  tier: CustomerTier,
  now: Date,
): PlanResult {
  const locations = settings.meetupLocations.locations;
  for (const field of ["pickupLocationId", "returnLocationId"] as const) {
    if (!locations.some((location) => location.id === request[field] && location.active)) {
      return { ok: false, field, problem: "UNKNOWN_LOCATION" };
    }
  }

  const slots = settings.handoverSlots.slots;
  const pickup = resolveSlot(slots, {
    date: request.pickupDate,
    slotId: request.pickupSlotId,
    kind: "pickup",
    locationId: request.pickupLocationId,
  });
  if (!pickup.ok) {
    return {
      ok: false,
      field: pickup.problem === "LOCATION_NOT_SERVED" ? "pickupLocationId" : "pickupSlotId",
      problem: pickup.problem,
    };
  }
  const ret = resolveSlot(slots, {
    date: request.returnDate,
    slotId: request.returnSlotId,
    kind: "return",
    locationId: request.returnLocationId,
  });
  if (!ret.ok) {
    return {
      ok: false,
      field: ret.problem === "LOCATION_NOT_SERVED" ? "returnLocationId" : "returnSlotId",
      problem: ret.problem,
    };
  }

  if (request.pickupDate > addDays(mytDateString(now), MAX_BOOKING_DAYS_AHEAD)) {
    return { ok: false, field: "pickupDate", problem: "TOO_FAR_AHEAD" };
  }
  const violation = validateRentalPeriod({
    now,
    pickupAt: pickup.value.start,
    returnAt: ret.value.start,
    minLeadHours: settings.minLeadHours.hours,
    maxRentalDays: settings.maxRentalDays.days,
  });
  if (violation) {
    return {
      ok: false,
      field: violation === "LEAD_TIME_TOO_SHORT" ? "pickupDate" : "returnDate",
      problem: violation,
    };
  }

  const days = rentalDays(pickup.value.start, ret.value.start);
  let priced: Quote;
  try {
    priced = quote(
      {
        rentalDays: days,
        addOns: request.addOns,
        pickupLocationId: request.pickupLocationId,
        returnLocationId: request.returnLocationId,
        customerTier: tier,
      },
      settings,
    );
  } catch (error) {
    if (error instanceof DomainError) {
      return { ok: false, field: "addOns", problem: "INVALID_ADD_ONS" };
    }
    throw error;
  }

  return {
    ok: true,
    value: {
      pickup: pickup.value,
      return: ret.value,
      rentalDays: days,
      lockedDates: lockedDates({
        pickupAt: pickup.value.start,
        returnSlotEnd: ret.value.end,
        buffer: settings.buffer,
        peakPeriods: settings.peakPeriods.periods,
      }),
      quote: priced,
    },
  };
}
