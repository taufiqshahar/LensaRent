import { z } from "zod";
import { LEDGER_ENTRY_TYPES } from "./ledger";
import { CUSTOMER_TIERS } from "./pricing";
import { ACTOR_TYPES, BOOKING_STATUSES } from "./stateMachine";
import { isDateString, isTimeOfDay } from "./time";

/**
 * zod schemas shared by the web app and the Worker. Firestore validates nothing, so every
 * value is parsed with these in the Worker before it is written.
 */

// ── Primitives ──────────────────────────────────────────────────────────────────────────

/** Signed integer sen (ledger amounts can be negative). */
export const senSchema = z.int();
export const nonNegativeSenSchema = z.int().min(0);
export const positiveSenSchema = z.int().min(1);

export const dateStringSchema = z
  .string()
  .refine(isDateString, "must be a real calendar day formatted yyyy-MM-dd");
export const timeOfDaySchema = z.string().refine(isTimeOfDay, "must be formatted HH:mm");

/** Lower-case slug used for location and slot ids. */
export const slugSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "must be a lower-case slug");
/** Upper-case code used for add-ons and accessories. */
export const codeSchema = z
  .string()
  .regex(/^[A-Z0-9][A-Z0-9_]{0,39}$/, "must be an upper-case code");
export const phoneE164Schema = z
  .string()
  .regex(/^\+[1-9]\d{7,14}$/, "must be an E.164 phone number");
const labelSchema = z.string().trim().min(1).max(120);

// ── Enumerations ────────────────────────────────────────────────────────────────────────

export const bookingStatusSchema = z.enum(BOOKING_STATUSES);
export const actorTypeSchema = z.enum(ACTOR_TYPES);
export const ledgerEntryTypeSchema = z.enum(LEDGER_ENTRY_TYPES);
export const customerTierSchema = z.enum(CUSTOMER_TIERS);

export const UNIT_STATUSES = ["active", "maintenance", "retired"] as const;
export type UnitStatus = (typeof UNIT_STATUSES)[number];
export const unitStatusSchema = z.enum(UNIT_STATUSES);

export const LOCK_KINDS = ["hold", "booking", "maintenance"] as const;
export type LockKind = (typeof LOCK_KINDS)[number];
export const lockKindSchema = z.enum(LOCK_KINDS);

export const SLOT_KINDS = ["pickup", "return"] as const;
export type SlotKind = (typeof SLOT_KINDS)[number];

// ── settings/{key} values ───────────────────────────────────────────────────────────────

function allUnique<T>(items: readonly T[], key: (item: T) => string | number): boolean {
  return new Set(items.map(key)).size === items.length;
}

const pricingSchema = z
  .object({
    fixedPrices: z.array(z.object({ days: z.int().min(1), priceSen: positiveSenSchema })).min(1),
    dailyRateSen: positiveSenSchema,
  })
  .refine((value) => value.fixedPrices.every((entry, index) => entry.days === index + 1), {
    message: "fixedPrices must cover days 1, 2, 3… in order with no gaps",
    path: ["fixedPrices"],
  });

const addOnsSchema = z
  .object({
    items: z.array(
      z.object({
        code: codeSchema,
        name: labelSchema,
        priceSen: nonNegativeSenSchema,
        maxQty: z.int().min(1).max(10),
        active: z.boolean(),
        lensFilter: z.boolean(),
      }),
    ),
    lensFilterBase: z.object({ code: codeSchema, name: labelSchema }),
  })
  .refine((value) => allUnique(value.items, (item) => item.code), {
    message: "add-on codes must be unique",
    path: ["items"],
  });

const meetupLocationsSchema = z
  .object({
    locations: z
      .array(
        z.object({
          id: slugSchema,
          name: labelSchema,
          feeSen: nonNegativeSenSchema,
          active: z.boolean(),
        }),
      )
      .min(1),
  })
  .refine((value) => allUnique(value.locations, (location) => location.id), {
    message: "location ids must be unique",
    path: ["locations"],
  });

const handoverSlotSchema = z
  .object({
    id: slugSchema,
    label: labelSchema,
    /** 0 = Sunday … 6 = Saturday, in MYT. */
    daysOfWeek: z.array(z.int().min(0).max(6)).min(1),
    startTime: timeOfDaySchema,
    endTime: timeOfDaySchema,
    kinds: z.array(z.enum(SLOT_KINDS)).min(1),
    locationIds: z.array(slugSchema).min(1),
    active: z.boolean(),
  })
  .refine((slot) => slot.startTime < slot.endTime, {
    message: "slot must end after it starts",
    path: ["endTime"],
  })
  .refine((slot) => allUnique(slot.daysOfWeek, (day) => day), {
    message: "daysOfWeek must not repeat",
    path: ["daysOfWeek"],
  });

const handoverSlotsSchema = z
  .object({ slots: z.array(handoverSlotSchema) })
  .refine((value) => allUnique(value.slots, (slot) => slot.id), {
    message: "slot ids must be unique",
    path: ["slots"],
  });

const depositTiersSchema = z.object({
  new: nonNegativeSenSchema,
  verified: nonNegativeSenSchema,
  returning: nonNegativeSenSchema,
});

const bufferSchema = z.object({
  normalHours: z.int().min(0).max(168),
  peakHours: z.int().min(0).max(168),
});

const peakPeriodsSchema = z.object({
  periods: z.array(
    z
      .object({ from: dateStringSchema, to: dateStringSchema, label: labelSchema.optional() })
      .refine((period) => period.from <= period.to, {
        message: "period must end on or after its start",
        path: ["to"],
      }),
  ),
});

const lateFeeSchema = z.object({
  graceMinutes: z.int().min(0).max(1440),
  blockHours: z.int().min(1).max(24),
  perBlockSen: nonNegativeSenSchema,
  capPer24hSen: nonNegativeSenSchema,
});

const cancellationSchema = z
  .object({
    fullRefundAboveHours: z.int().min(0).max(720),
    feeWindowFromHours: z.int().min(0).max(720),
    feeSen: nonNegativeSenSchema,
  })
  .refine((value) => value.fullRefundAboveHours >= value.feeWindowFromHours, {
    message: "full-refund line must not be closer to pickup than the fee window",
    path: ["fullRefundAboveHours"],
  });

const versionSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/, "must be a version");

const policyVersionsSchema = z.object({
  terms: versionSchema,
  privacy: versionSchema,
  rentalPolicy: versionSchema,
});

const businessInfoSchema = z.object({
  brandName: labelSchema,
  /** Registered business details for the footer (CPETTR 2024). Empty until confirmed. */
  legalName: z.string().trim().max(160),
  ssmNumber: z.string().trim().max(40),
  address: z.string().trim().max(300),
  phoneE164: phoneE164Schema,
  whatsappE164: phoneE164Schema,
  email: z.union([z.email(), z.literal("")]),
});

/** One schema per `settings/{key}` document; each validates that document's `value` map. */
export const settingsSchemas = {
  pricing: pricingSchema,
  addOns: addOnsSchema,
  meetupLocations: meetupLocationsSchema,
  handoverSlots: handoverSlotsSchema,
  depositTiers: depositTiersSchema,
  buffer: bufferSchema,
  peakPeriods: peakPeriodsSchema,
  holdMinutes: z.object({ minutes: z.int().min(1).max(1440) }),
  minLeadHours: z.object({ hours: z.int().min(0).max(720) }),
  maxRentalDays: z.object({ days: z.int().min(1).max(30) }),
  lateFee: lateFeeSchema,
  cancellation: cancellationSchema,
  policyVersions: policyVersionsSchema,
  businessInfo: businessInfoSchema,
} as const;

export type SettingsKey = keyof typeof settingsSchemas;
export type SettingsValue<K extends SettingsKey> = z.infer<(typeof settingsSchemas)[K]>;
export type AllSettings = { [K in SettingsKey]: SettingsValue<K> };

export const SETTINGS_KEYS = Object.keys(settingsSchemas) as SettingsKey[];

export function isSettingsKey(value: string): value is SettingsKey {
  return Object.hasOwn(settingsSchemas, value);
}

/** Validates a `settings/{key}` value. Throws a `ZodError` when it is not valid. */
export function parseSettingsValue<K extends SettingsKey>(
  key: K,
  value: unknown,
): SettingsValue<K> {
  return settingsSchemas[key].parse(value) as SettingsValue<K>;
}
