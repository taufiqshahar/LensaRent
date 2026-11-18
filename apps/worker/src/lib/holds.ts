import type { AllSettings, BookingPlan, CustomerTier, HoldRequest } from "@lensarent/shared";
import { REF_CODE_ALPHABET, addMinutes, formatRM } from "@lensarent/shared";
import { acquireDayLocks, releaseBookingLocksStatement } from "./availabilityLocks";
import type { Actor, BookingRow } from "./bookings";
import { prepareTransition, runTransition } from "./bookings";
import type { CheckoutLine, PaymentProvider } from "./chip";
import type { Hasher } from "./crypto";
import { sha256 } from "./crypto";
import { isUniqueViolation, newId } from "./db";
import type { Logger } from "./logger";

/**
 * Holds: a customer's dates are locked for `holdMinutes` while they pay (master prompt §6).
 *
 * 1. Lock the days on the first free unit, in ONE batch with the booking row and its
 *    first event (`acquireDayLocks`). Racing requests: exactly one wins per unit.
 * 2. Create the CHIP purchase, due at the end of the hold (`due_strict`), so it cannot be
 *    paid after the hold is gone.
 * 3. Record the payment. If step 2 or 3 fails, the hold is cancelled and its days freed
 *    straight away — the customer is never left holding dates without a way to pay.
 */
export const SYSTEM_ACTOR: Actor = { type: "system", id: "system:web" };
const MAX_ID_ATTEMPTS = 3;

/** PK- + 6 characters from an unambiguous alphabet (31^6 ≈ 887 million codes). */
export function newRefCode(): string {
  const limit = 256 - (256 % REF_CODE_ALPHABET.length);
  const code: string[] = [];
  while (code.length < 6) {
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
      if (byte < limit && code.length < 6) {
        code.push(REF_CODE_ALPHABET.charAt(byte % REF_CODE_ALPHABET.length));
      }
    }
  }
  return `PK-${code.join("")}`;
}

export interface Customer {
  id: string;
  tier: CustomerTier;
  blocked: boolean;
}

/**
 * Finds or creates the customer for a phone number (one per phone, enforced by a UNIQUE
 * key). An existing customer's name and email are NOT overwritten: anyone can type any
 * phone number, so the booking keeps its own snapshot and the record stays as it was.
 */
export async function upsertCustomer(
  db: D1Database,
  input: { phoneHash: string; name: string; phoneE164: string; email: string; now: Date },
): Promise<Customer> {
  const at = input.now.toISOString();
  const row = await db
    .prepare(
      `INSERT INTO customers (id, phone_hash, name, phone_e164, email, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (phone_hash) DO UPDATE SET updated_at = excluded.updated_at
       RETURNING id, tier, blocked`,
    )
    .bind(newId(), input.phoneHash, input.name, input.phoneE164, input.email, at, at)
    .first<{ id: string; tier: CustomerTier; blocked: number }>();
  if (!row) throw new Error("Customer upsert returned no row");
  return { id: row.id, tier: row.tier, blocked: row.blocked === 1 };
}

/** Unpaid holds this customer still has open. */
export async function openHoldCount(
  db: D1Database,
  customerId: string,
  now: Date,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM bookings
       WHERE customer_id = ? AND status = 'pending_payment' AND hold_expires_at > ?`,
    )
    .bind(customerId, now.toISOString())
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export interface HoldInput {
  request: HoldRequest;
  plan: BookingPlan;
  customer: Customer;
  consentIpHash: string;
  settings: AllSettings;
  now: Date;
}

export interface CreatedHold {
  bookingId: string;
  refCode: string;
  unitId: string;
  lookupToken: string;
  holdExpiresAt: Date;
}

/** Locks the days on the first free active unit. Null when every unit is taken. */
export async function createHold(
  db: D1Database,
  hasher: Hasher,
  input: HoldInput,
): Promise<CreatedHold | null> {
  const { request, plan, customer, settings, now } = input;
  const { results: units } = await db
    .prepare("SELECT id FROM units WHERE status = 'active' ORDER BY sort_order, id")
    .all<{ id: string }>();
  const holdExpiresAt = addMinutes(now, settings.holdMinutes.minutes);
  const breakdown = plan.quote.breakdown;
  const at = now.toISOString();

  for (const unit of units) {
    for (let attempt = 1; ; attempt++) {
      const bookingId = newId();
      const refCode = newRefCode();
      const lookupToken = await hasher.hash("lookup", bookingId);
      const transitionId = newId();
      const insertBooking = db
        .prepare(
          `INSERT INTO bookings (id, ref_code, lookup_token_hash, unit_id, customer_id,
             customer_name, customer_phone_e164, customer_email,
             pickup_slot_id, pickup_at, pickup_location_id,
             return_slot_id, return_at, return_slot_end, return_location_id,
             locked_dates, rental_days, add_ons,
             rental_sen, add_ons_sen, meetup_sen, discount_sen, deposit_sen, total_payable_sen,
             status, last_transition_id, hold_expires_at,
             terms_version, privacy_version, consent_at, consent_ip_hash, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             'pending_payment', ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          bookingId,
          refCode,
          await sha256(lookupToken),
          unit.id,
          customer.id,
          request.name,
          request.phone,
          request.email,
          request.pickupSlotId,
          plan.pickup.start.toISOString(),
          request.pickupLocationId,
          request.returnSlotId,
          plan.return.start.toISOString(),
          plan.return.end.toISOString(),
          request.returnLocationId,
          JSON.stringify(plan.lockedDates),
          plan.rentalDays,
          JSON.stringify({ lines: plan.quote.addOnLines, included: plan.quote.includedItems }),
          breakdown.rentalSen,
          breakdown.addOnsSen,
          breakdown.meetupSen,
          breakdown.discountSen,
          breakdown.depositSen,
          breakdown.totalPayableSen,
          transitionId,
          holdExpiresAt.toISOString(),
          settings.policyVersions.terms,
          settings.policyVersions.privacy,
          at,
          input.consentIpHash,
          at,
          at,
        );
      const firstEvent = db
        .prepare(
          `INSERT INTO booking_events (id, booking_id, from_status, to_status, actor_id, actor_type, reason, at)
           VALUES (?, ?, NULL, 'pending_payment', ?, 'system', 'hold', ?)`,
        )
        .bind(newId(), bookingId, SYSTEM_ACTOR.id, at);

      try {
        const result = await acquireDayLocks(
          db,
          { unitId: unit.id, dates: plan.lockedDates, kind: "hold", bookingId, holdExpiresAt },
          now,
          [insertBooking, firstEvent],
        );
        if (!result.acquired) break; // This unit is taken: try the next one.
        return { bookingId, refCode, unitId: unit.id, lookupToken, holdExpiresAt };
      } catch (error) {
        // A reference code collision (about 1 in 887 million): retry with fresh ids.
        if (isUniqueViolation(error) && attempt < MAX_ID_ATTEMPTS) continue;
        throw error;
      }
    }
  }
  return null;
}

/**
 * Cancels an unpaid hold and frees its days, in one guarded batch. Callers that have a
 * CHIP purchase must make it unpayable FIRST (`provider.cancel`), so a payment can never
 * land on a hold whose days were given away.
 */
export async function cancelHold(
  db: D1Database,
  booking: Pick<BookingRow, "id" | "status">,
  reason: string,
  actor: Actor,
  now: Date,
  extra: (guard: { sql: string; params: readonly string[] }) => D1PreparedStatement[] = () => [],
): Promise<void> {
  const prepared = prepareTransition(
    db,
    booking,
    { to: "cancelled", actor, reason, now },
    (guard) => [
      releaseBookingLocksStatement(db, booking.id, guard),
      db
        .prepare(
          `UPDATE payments SET status = 'cancelled', updated_at = ?
         WHERE booking_id = ? AND status = 'created' AND ${guard.sql}`,
        )
        .bind(now.toISOString(), booking.id, ...guard.params),
      ...extra(guard),
    ],
  );
  await runTransition(db, prepared);
}

/** CHIP line items. Names are customer-facing (Bahasa Melayu); amounts come from the plan. */
export function checkoutLines(plan: BookingPlan): CheckoutLine[] {
  const { breakdown, addOnLines, rentalDays } = plan.quote;
  if (breakdown.discountSen !== 0) {
    // Online bookings carry no discount in the MVP; refuse rather than mis-charge.
    throw new Error("Discounts are not supported at checkout");
  }
  const lines: CheckoutLine[] = [
    {
      name: `Sewa DJI Osmo Pocket 4P (${rentalDays.toString()} hari)`,
      priceSen: breakdown.rentalSen,
    },
    ...addOnLines.map((line) => ({
      name: line.qty > 1 ? `${line.name} × ${line.qty.toString()}` : line.name,
      priceSen: line.totalSen,
    })),
  ];
  if (breakdown.meetupSen > 0)
    lines.push({ name: "Caj lokasi serahan", priceSen: breakdown.meetupSen });
  if (breakdown.depositSen > 0) {
    lines.push({
      name: `Deposit keselamatan ${formatRM(breakdown.depositSen)} (dipulangkan)`,
      priceSen: breakdown.depositSen,
    });
  }
  return lines.filter((line) => line.priceSen > 0);
}

export interface StartPaymentInput {
  hold: CreatedHold;
  request: HoldRequest;
  plan: BookingPlan;
  origin: string;
  /** Production must never take a test-mode payment. */
  production: boolean;
  now: Date;
}

/**
 * Creates the CHIP purchase for a hold and records it. On any failure the hold is
 * cancelled (after making a created purchase unpayable) and null is returned.
 */
export async function startPayment(
  db: D1Database,
  provider: PaymentProvider,
  logger: Logger,
  input: StartPaymentInput,
): Promise<{ checkoutUrl: string } | null> {
  const { hold, request, plan, origin, now } = input;
  let providerRef: string | undefined;
  try {
    const status = `${origin}/tempahan?ref=${encodeURIComponent(hold.refCode)}`;
    const checkout = await provider.createCheckout({
      reference: hold.refCode,
      customer: { email: request.email, fullName: request.name, phone: request.phone },
      lines: checkoutLines(plan),
      due: hold.holdExpiresAt,
      successRedirect: `${status}&bayaran=berjaya`,
      failureRedirect: `${status}&bayaran=gagal`,
      cancelRedirect: `${status}&bayaran=batal`,
      callbackUrl: `${origin}/api/webhooks/chip`,
    });
    providerRef = checkout.providerRef;
    if (input.production && checkout.isTest) throw new Error("Test-mode CHIP key in production");

    const at = now.toISOString();
    await db
      .prepare(
        `INSERT INTO payments (id, booking_id, provider, provider_ref, expected_sen, status,
           is_test, checkout_url, created_at, updated_at)
         VALUES (?, ?, 'chip', ?, ?, 'created', ?, ?, ?, ?)`,
      )
      .bind(
        newId(),
        hold.bookingId,
        checkout.providerRef,
        plan.quote.breakdown.totalPayableSen,
        checkout.isTest ? 1 : 0,
        checkout.checkoutUrl,
        at,
        at,
      )
      .run();
    return { checkoutUrl: checkout.checkoutUrl };
  } catch (error) {
    logger.error("hold.payment_start_failed", { bookingId: hold.bookingId, error });
    try {
      if (providerRef !== undefined && !(await provider.cancel(providerRef))) {
        // Could not be made unpayable: keep the hold; reconciliation settles it.
        logger.error("hold.purchase_not_cancelled", { bookingId: hold.bookingId });
        return null;
      }
      await cancelHold(
        db,
        { id: hold.bookingId, status: "pending_payment" },
        "checkout_failed",
        SYSTEM_ACTOR,
        now,
      );
    } catch (cleanupError) {
      // The hold expires on its own and the reconciliation job tidies it up.
      logger.error("hold.cleanup_failed", { bookingId: hold.bookingId, error: cleanupError });
    }
    return null;
  }
}
