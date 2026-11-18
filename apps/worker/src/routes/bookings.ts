import type { AllSettings, BookingField, BookingStatus, PlanProblem } from "@lensarent/shared";
import {
  MAX_BOOKING_DAYS_AHEAD,
  REF_CODE_PATTERN,
  addDays,
  dateStringSchema,
  diffDays,
  eachDate,
  holdRequestSchema,
  isDateString,
  mytDateString,
  planBooking,
  quoteRequestSchema,
} from "@lensarent/shared";
import { z } from "zod";
import { constantTimeEqual, sha256 } from "../lib/crypto";
import { placeholders } from "../lib/db";
import {
  clientIp,
  errorResponse,
  jsonResponse,
  rateLimitedResponse,
  readJson,
  validationErrorResponse,
} from "../lib/http";
import { createHold, openHoldCount, startPayment, upsertCustomer } from "../lib/holds";
import { RATE_LIMIT_RULES, hitRateLimit } from "../lib/rateLimit";
import type { Handler, RequestContext } from "../router";
import { fieldErrors } from "./validation";

/** A customer may have this many unpaid holds open at once (anti date-squatting). */
export const MAX_OPEN_HOLDS_PER_CUSTOMER = 2;
/** Longest range the availability calendar answers for in one request. */
export const MAX_AVAILABILITY_DAYS = 62;

export const BOOKING_FIELD_MESSAGES: Readonly<Record<string, string>> = {
  pickupDate: "Sila pilih tarikh ambil yang sah.",
  pickupSlotId: "Sila pilih slot ambil yang ditawarkan pada hari itu.",
  pickupLocationId: "Sila pilih lokasi ambil yang ditawarkan.",
  returnDate: "Sila pilih tarikh pulang yang sah.",
  returnSlotId: "Sila pilih slot pulang yang ditawarkan pada hari itu.",
  returnLocationId: "Sila pilih lokasi pulang yang ditawarkan.",
  addOns: "Sila semak pilihan tambahan.",
  name: "Sila masukkan nama penuh anda (2 hingga 80 aksara).",
  phone: "Sila masukkan nombor telefon bimbit Malaysia yang sah, contohnya 012-345 6789.",
  email: "Sila masukkan alamat e-mel yang sah. Resit dihantar ke sini.",
  consent: "Sila tandakan bahawa anda bersetuju dengan terma sewaan dan notis privasi.",
  turnstileToken: "Sila lengkapkan pengesahan keselamatan.",
};

const PROBLEM_MESSAGES: Readonly<Partial<Record<PlanProblem, string>>> = {
  LEAD_TIME_TOO_SHORT:
    "Tempahan perlu dibuat lebih awal. Sila pilih tarikh ambil yang lebih lewat.",
  TOO_FAR_AHEAD: "Tarikh ambil terlalu jauh ke hadapan.",
  RETURN_NOT_AFTER_PICKUP: "Masa pulang mesti selepas masa ambil.",
  EXCEEDS_MAX_RENTAL_DAYS: "Tempoh sewaan melebihi had maksimum.",
};

function planErrorResponse(field: BookingField, problem: PlanProblem): Response {
  return validationErrorResponse({
    [field]: PROBLEM_MESSAGES[problem] ?? BOOKING_FIELD_MESSAGES[field] ?? "Nilai ini tidak sah.",
  });
}

async function burstLimited(context: RequestContext, scope: string): Promise<Response | null> {
  const limiter = context.services.burstLimiter;
  if (!limiter) return null;
  const ip = clientIp(context.request) ?? "unknown";
  const { success } = await limiter.limit({ key: `${scope}:${ip}` });
  return success ? null : rateLimitedResponse(60);
}

async function activeUnitIds(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT id FROM units WHERE status = 'active' ORDER BY sort_order, id")
    .all<{ id: string }>();
  return results.map((row) => row.id);
}

/** Days (of `dates`) on which every active unit is locked. */
async function fullyBookedDates(db: D1Database, dates: readonly string[]): Promise<Set<string>> {
  const units = await activeUnitIds(db);
  if (units.length === 0) return new Set(dates);
  const { results } = await db
    .prepare(
      `SELECT date FROM availability_locks
       WHERE date IN (${placeholders(dates.length)}) AND unit_id IN (${placeholders(units.length)})
       GROUP BY date HAVING COUNT(DISTINCT unit_id) >= ?`,
    )
    .bind(...dates, ...units, units.length)
    .all<{ date: string }>();
  return new Set(results.map((row) => row.date));
}

/** True when at least one active unit has none of `dates` locked. */
async function anyUnitFree(db: D1Database, dates: readonly string[]): Promise<boolean> {
  const units = await activeUnitIds(db);
  if (units.length === 0) return false;
  const { results } = await db
    .prepare(
      `SELECT DISTINCT unit_id FROM availability_locks
       WHERE unit_id IN (${placeholders(units.length)}) AND date IN (${placeholders(dates.length)})`,
    )
    .bind(...units, ...dates)
    .all<{ unit_id: string }>();
  return results.length < units.length;
}

/** Online booking needs a payment provider, at least one slot and at least one unit. */
function bookingOpen(context: RequestContext, settings: AllSettings): boolean {
  return (
    context.services.payments !== undefined &&
    settings.handoverSlots.slots.some((slot) => slot.active)
  );
}

/**
 * GET /api/config — what the booking wizard needs to draw itself. Everything here is
 * public (it is on the website anyway); nothing is customer-specific.
 */
export const bookingConfigHandler: Handler = async (context) => {
  const settings = await context.services.settings();
  const units = await activeUnitIds(context.services.db);
  return jsonResponse({
    bookingOpen: bookingOpen(context, settings) && units.length > 0,
    today: mytDateString(context.services.now()),
    maxDaysAhead: MAX_BOOKING_DAYS_AHEAD,
    pricing: settings.pricing,
    depositSen: settings.depositTiers.new,
    addOns: {
      items: settings.addOns.items.filter((item) => item.active),
      lensFilterBase: settings.addOns.lensFilterBase,
    },
    locations: settings.meetupLocations.locations.filter((location) => location.active),
    slots: settings.handoverSlots.slots.filter((slot) => slot.active),
    minLeadHours: settings.minLeadHours.hours,
    maxRentalDays: settings.maxRentalDays.days,
    holdMinutes: settings.holdMinutes.minutes,
    policyVersions: settings.policyVersions,
  });
};

const availabilityQuerySchema = z
  .object({ from: dateStringSchema, to: dateStringSchema })
  // zod runs object refinements even when a field failed, so re-check the dates first.
  .refine(
    (query) =>
      isDateString(query.from) &&
      isDateString(query.to) &&
      query.from <= query.to &&
      diffDays(query.from, query.to) < MAX_AVAILABILITY_DAYS,
  );

/**
 * GET /api/availability?from=yyyy-MM-dd&to=yyyy-MM-dd — which days have no free unit.
 * A calendar hint only: the hold is the real check. Says nothing about how many units.
 */
export const availabilityHandler: Handler = async (context) => {
  const limited = await burstLimited(context, "availability");
  if (limited) return limited;

  const parsed = availabilityQuerySchema.safeParse({
    from: context.url.searchParams.get("from"),
    to: context.url.searchParams.get("to"),
  });
  if (!parsed.success) return validationErrorResponse({ from: "Julat tarikh tidak sah." });
  const today = mytDateString(context.services.now());
  const from = parsed.data.from < today ? today : parsed.data.from;
  const last = addDays(today, MAX_BOOKING_DAYS_AHEAD);
  const to = parsed.data.to > last ? last : parsed.data.to;
  if (from > to) return jsonResponse({ from, to, unavailable: [] });

  const dates = eachDate(from, to);
  const full = await fullyBookedDates(context.services.db, dates);
  return jsonResponse({ from, to, unavailable: dates.filter((date) => full.has(date)) });
};

/** POST /api/quote — the server's price for a period, and whether it is still free. */
export const quoteHandler: Handler = async (context) => {
  const limited = await burstLimited(context, "quote");
  if (limited) return limited;

  const body = await readJson(context.request);
  if (!body.ok) return body.response;
  const parsed = quoteRequestSchema.safeParse(body.value);
  if (!parsed.success) {
    return validationErrorResponse(fieldErrors(parsed.error, BOOKING_FIELD_MESSAGES));
  }
  const settings = await context.services.settings();
  const plan = planBooking(parsed.data, settings, "new", context.services.now());
  if (!plan.ok) return planErrorResponse(plan.field, plan.problem);

  const { quote, rentalDays, pickup, lockedDates } = plan.value;
  return jsonResponse({
    rentalDays,
    pickupAt: pickup.start.toISOString(),
    returnAt: plan.value.return.start.toISOString(),
    returnSlotEnd: plan.value.return.end.toISOString(),
    addOnLines: quote.addOnLines,
    includedItems: quote.includedItems,
    breakdown: quote.breakdown,
    available: await anyUnitFree(context.services.db, lockedDates),
  });
};

/**
 * POST /api/bookings/hold — lock the dates and start payment.
 *
 * Cheap checks first (burst limit, shape, rules), then Turnstile, then the D1 rate limits,
 * then writes. Prices always come from the server's settings, never from the client.
 */
export const holdHandler: Handler = async (context) => {
  const { request, url, services, config, logger } = context;
  const limited = await burstLimited(context, "hold");
  if (limited) return limited;
  const payments = services.payments;
  const settings = await services.settings();
  if (!payments || !bookingOpen(context, settings)) return errorResponse("BOOKING_CLOSED");

  const body = await readJson(request);
  if (!body.ok) return body.response;
  const parsed = holdRequestSchema.safeParse(body.value);
  if (!parsed.success) {
    return validationErrorResponse(fieldErrors(parsed.error, BOOKING_FIELD_MESSAGES));
  }
  const hold = parsed.data;
  const now = services.now();

  // Validate the period before spending a Turnstile token; re-plan with the real tier below.
  const draft = planBooking(hold, settings, "new", now);
  if (!draft.ok) return planErrorResponse(draft.field, draft.problem);

  const ip = clientIp(request) ?? "unknown";
  const human = await services.turnstile.verify({
    token: hold.turnstileToken,
    remoteIp: ip === "unknown" ? undefined : ip,
    expectedAction: "booking",
    expectedHostname: url.hostname,
  });
  if (!human) return errorResponse("TURNSTILE_FAILED");

  const [ipHash, phoneHash] = await Promise.all([
    services.hasher.hash("ip", ip),
    services.hasher.hash("phone", hold.phone),
  ]);
  for (const [rule, key] of [
    [RATE_LIMIT_RULES.holdPerIp, ipHash],
    [RATE_LIMIT_RULES.holdPerPhone, phoneHash],
  ] as const) {
    const limit = await hitRateLimit(services.db, rule, key, now);
    if (!limit.allowed) {
      logger.warn("hold.rate_limited", { rule: rule.name });
      return rateLimitedResponse(limit.retryAfterSeconds);
    }
  }

  const customer = await upsertCustomer(services.db, {
    phoneHash,
    name: hold.name,
    phoneE164: hold.phone,
    email: hold.email,
    now,
  });
  if (customer.blocked) {
    logger.warn("hold.customer_blocked", {});
    return errorResponse("BOOKING_NOT_ALLOWED");
  }
  if ((await openHoldCount(services.db, customer.id, now)) >= MAX_OPEN_HOLDS_PER_CUSTOMER) {
    return errorResponse("TOO_MANY_HOLDS");
  }

  const plan = planBooking(hold, settings, customer.tier, now);
  if (!plan.ok) return planErrorResponse(plan.field, plan.problem);

  const created = await createHold(services.db, services.hasher, {
    request: hold,
    plan: plan.value,
    customer,
    consentIpHash: ipHash,
    settings,
    now,
  });
  if (!created) return errorResponse("SLOT_UNAVAILABLE");
  logger.info("hold.created", { bookingId: created.bookingId, refCode: created.refCode });

  const payment = await startPayment(services.db, payments, logger, {
    hold: created,
    request: hold,
    plan: plan.value,
    origin: url.origin,
    production: config.environment === "production",
    now,
  });
  if (!payment) return errorResponse("PAYMENT_UNAVAILABLE");

  return jsonResponse(
    {
      refCode: created.refCode,
      lookupToken: created.lookupToken,
      checkoutUrl: payment.checkoutUrl,
      holdExpiresAt: created.holdExpiresAt.toISOString(),
      breakdown: plan.value.quote.breakdown,
    },
    201,
  );
};

export const LOOKUP_TOKEN_HEADER = "x-booking-token";

interface LookupRow {
  id: string;
  ref_code: string;
  lookup_token_hash: string;
  status: BookingStatus;
  pickup_at: string;
  pickup_location_id: string;
  return_at: string;
  return_slot_end: string;
  return_location_id: string;
  rental_days: number;
  add_ons: string;
  rental_sen: number;
  add_ons_sen: number;
  meetup_sen: number;
  discount_sen: number;
  deposit_sen: number;
  total_payable_sen: number;
  hold_expires_at: string | null;
  receipt_no: string | null;
  checkout_url: string | null;
}

/**
 * GET /api/bookings/lookup?ref=PK-XXXXXX with the lookup token in `X-Booking-Token`.
 * The token never travels in a URL (no logs, no Referer). A wrong reference and a wrong
 * token get the same 404, so the endpoint cannot be used to discover references.
 */
export const lookupHandler: Handler = async (context) => {
  const limited = await burstLimited(context, "lookup");
  if (limited) return limited;

  const ref = context.url.searchParams.get("ref") ?? "";
  const token = context.request.headers.get(LOOKUP_TOKEN_HEADER) ?? "";
  if (!REF_CODE_PATTERN.test(ref) || !/^[A-Za-z0-9_-]{16,64}$/.test(token)) {
    return errorResponse("NOT_FOUND");
  }
  const row = await context.services.db
    .prepare(
      `SELECT b.id, b.ref_code, b.lookup_token_hash, b.status, b.pickup_at, b.pickup_location_id,
         b.return_at, b.return_slot_end, b.return_location_id, b.rental_days, b.add_ons,
         b.rental_sen, b.add_ons_sen, b.meetup_sen, b.discount_sen, b.deposit_sen,
         b.total_payable_sen, b.hold_expires_at, b.receipt_no,
         (SELECT p.checkout_url FROM payments p WHERE p.booking_id = b.id AND p.status = 'created'
          ORDER BY p.created_at DESC LIMIT 1) AS checkout_url
       FROM bookings b WHERE b.ref_code = ?`,
    )
    .bind(ref)
    .first<LookupRow>();
  const tokenHash = await sha256(token);
  if (!row || !constantTimeEqual(tokenHash, row.lookup_token_hash)) {
    return errorResponse("NOT_FOUND");
  }

  const now = context.services.now();
  const payable =
    row.status === "pending_payment" &&
    row.hold_expires_at !== null &&
    new Date(row.hold_expires_at) > now;
  const addOns = JSON.parse(row.add_ons) as unknown;
  return jsonResponse({
    refCode: row.ref_code,
    status: row.status,
    pickupAt: row.pickup_at,
    pickupLocationId: row.pickup_location_id,
    returnAt: row.return_at,
    returnSlotEnd: row.return_slot_end,
    returnLocationId: row.return_location_id,
    rentalDays: row.rental_days,
    addOns,
    breakdown: {
      rentalSen: row.rental_sen,
      addOnsSen: row.add_ons_sen,
      meetupSen: row.meetup_sen,
      discountSen: row.discount_sen,
      depositSen: row.deposit_sen,
      totalPayableSen: row.total_payable_sen,
    },
    holdExpiresAt: row.hold_expires_at,
    checkoutUrl: payable ? row.checkout_url : null,
    receiptNo: row.receipt_no,
  });
};
