import { mytDateString } from "@lensarent/shared";
import { confirmBookingLocksStatement, releaseBookingLocksStatement } from "./availabilityLocks";
import type { Actor, BookingRow, Guard } from "./bookings";
import {
  StaleBookingError,
  getBooking,
  ledgerStatement,
  prepareTransition,
  runTransition,
} from "./bookings";
import type { PaymentState } from "./chip";
import type { Logger } from "./logger";
import { outboxStatement } from "./outbox";

/**
 * Settles a CHIP purchase that CHIP reports as paid — from the callback or from the
 * reconciliation job, which share this one function so they cannot disagree.
 *
 * The amount, currency, reference and test flag are checked against what we expected.
 * A match confirms the booking; anything else moves it to `refund_pending`, frees its
 * days and alerts the admin. Every write for one outcome is one guarded batch, so a
 * repeated or concurrent delivery changes nothing the second time.
 */
export const PAYMENT_ACTOR: Actor = { type: "webhook", id: "chip" };

export interface PaymentRow {
  id: string;
  booking_id: string;
  provider_ref: string;
  expected_sen: number;
  status: "created" | "paid" | "mismatch" | "cancelled";
  is_test: number;
}

export type Settlement =
  "confirmed" | "already_processed" | "not_paid" | "mismatch" | "paid_after_close";

export interface SettlementContext {
  db: D1Database;
  logger: Logger;
  production: boolean;
  alertEmails: readonly string[];
  now: Date;
}

export async function findPaymentByRef(
  db: D1Database,
  providerRef: string,
): Promise<PaymentRow | null> {
  return db
    .prepare(
      `SELECT id, booking_id, provider_ref, expected_sen, status, is_test
       FROM payments WHERE provider_ref = ?`,
    )
    .bind(providerRef)
    .first<PaymentRow>();
}

function paymentProblem(
  booking: BookingRow,
  payment: PaymentRow,
  state: PaymentState,
  production: boolean,
): string | null {
  const received = state.paidSen ?? state.totalSen;
  if (state.currency !== "MYR") return "currency";
  if (state.reference !== booking.ref_code) return "reference";
  if (received !== payment.expected_sen || received !== booking.total_payable_sen) return "amount";
  if (production && state.isTest) return "test_mode";
  if (state.isTest !== (payment.is_test === 1)) return "test_mode";
  return null;
}

function alertStatements(
  context: SettlementContext,
  guard: Guard | null,
  template: "admin_new_booking" | "admin_payment_problem",
  bookingId: string,
): D1PreparedStatement[] {
  return context.alertEmails.map((to) =>
    outboxStatement(context.db, guard, {
      template,
      to,
      payload: { bookingId },
      dedupeKey: `${template}:${bookingId}:${to}`,
      sendAfter: context.now,
      createdAt: context.now,
    }),
  );
}

export async function settlePayment(
  context: SettlementContext,
  payment: PaymentRow,
  state: PaymentState,
): Promise<Settlement> {
  const { db, logger, now } = context;
  const at = now.toISOString();
  if (!state.paid) return "not_paid";
  if (payment.status === "paid" || payment.status === "mismatch") return "already_processed";

  const booking = await getBooking(db, payment.booking_id);
  if (!booking) throw new Error("Payment without a booking");
  const paidSen = state.paidSen ?? state.totalSen;
  const paidAt = (state.paidAt ?? now).toISOString();

  if (booking.status !== "pending_payment") {
    // Should not happen: holds are only cancelled after CHIP makes the purchase unpayable.
    // Record the money and tell the admin, who refunds it by hand.
    const [update] = await db.batch([
      db
        .prepare(
          `UPDATE payments SET status = 'paid', paid_sen = ?, fee_sen = ?, raw_status = ?,
             paid_at = ?, updated_at = ? WHERE id = ? AND status <> 'paid'`,
        )
        .bind(paidSen, state.feeSen, state.status, paidAt, at, payment.id),
      ...alertStatements(context, null, "admin_payment_problem", booking.id),
    ]);
    logger.error("payment.after_close", { bookingId: booking.id, refCode: booking.ref_code });
    return update?.meta.changes === 1 ? "paid_after_close" : "already_processed";
  }

  const problem = paymentProblem(booking, payment, state, context.production);
  try {
    if (problem) {
      const prepared = prepareTransition(
        db,
        booking,
        {
          to: "refund_pending",
          actor: PAYMENT_ACTOR,
          reason: `payment_${problem}`,
          // Everything received goes back; none of it was ever booked as income.
          set: { refund_due_sen: paidSen },
          now,
        },
        (guard) => [
          releaseBookingLocksStatement(db, booking.id, guard),
          db
            .prepare(
              `UPDATE payments SET status = 'mismatch', paid_sen = ?, fee_sen = ?, raw_status = ?,
                 paid_at = ?, updated_at = ? WHERE id = ? AND ${guard.sql}`,
            )
            .bind(paidSen, state.feeSen, state.status, paidAt, at, payment.id, ...guard.params),
          ...alertStatements(context, guard, "admin_payment_problem", booking.id),
        ],
      );
      await runTransition(db, prepared);
      logger.error("payment.mismatch", {
        bookingId: booking.id,
        refCode: booking.ref_code,
        problem,
      });
      return "mismatch";
    }

    const year = mytDateString(now).slice(0, 4);
    const prepared = prepareTransition(
      db,
      booking,
      { to: "confirmed", actor: PAYMENT_ACTOR, reason: "paid", now },
      (guard) => {
        const ledger = (
          type: "RENTAL" | "ADD_ON" | "MEETUP_FEE" | "DISCOUNT" | "DEPOSIT_IN" | "GATEWAY_FEE",
          amountSen: number,
        ) =>
          ledgerStatement(db, guard, {
            bookingId: booking.id,
            type,
            amountSen,
            method: "gateway",
            reference: payment.provider_ref,
            createdBy: PAYMENT_ACTOR.id,
            at: now,
          });
        return [
          confirmBookingLocksStatement(db, booking.id, guard),
          db
            .prepare(
              `UPDATE payments SET status = 'paid', paid_sen = ?, fee_sen = ?, raw_status = ?,
                 paid_at = ?, updated_at = ? WHERE id = ? AND ${guard.sql}`,
            )
            .bind(paidSen, state.feeSen, state.status, paidAt, at, payment.id, ...guard.params),
          ledger("RENTAL", booking.rental_sen),
          ...(booking.add_ons_sen > 0 ? [ledger("ADD_ON", booking.add_ons_sen)] : []),
          ...(booking.meetup_sen > 0 ? [ledger("MEETUP_FEE", booking.meetup_sen)] : []),
          ...(booking.discount_sen > 0 ? [ledger("DISCOUNT", -booking.discount_sen)] : []),
          // The deposit is a liability held for the customer, never revenue.
          ...(booking.deposit_sen > 0 ? [ledger("DEPOSIT_IN", booking.deposit_sen)] : []),
          ...(state.feeSen ? [ledger("GATEWAY_FEE", -Math.abs(state.feeSen))] : []),
          // Receipt numbers: R-YYYY-00001, sequential per MYT year, no gaps.
          db
            .prepare(
              `INSERT INTO receipt_counters (year, last_number) SELECT ?, 1 WHERE ${guard.sql}
               ON CONFLICT (year) DO UPDATE SET last_number = last_number + 1`,
            )
            .bind(year, ...guard.params),
          db
            .prepare(
              `UPDATE bookings SET receipt_no = 'R-' || ?1 || '-' ||
                 printf('%05d', (SELECT last_number FROM receipt_counters WHERE year = ?1))
               WHERE id = ?2 AND last_transition_id = ?3`,
            )
            .bind(year, booking.id, guard.params[1]),
          outboxStatement(db, guard, {
            template: "booking_confirmed",
            to: booking.customer_email,
            payload: { bookingId: booking.id },
            dedupeKey: `booking_confirmed:${booking.id}`,
            sendAfter: now,
            createdAt: now,
          }),
          ...alertStatements(context, guard, "admin_new_booking", booking.id),
        ];
      },
    );
    await runTransition(db, prepared);
    logger.info("payment.confirmed", { bookingId: booking.id, refCode: booking.ref_code });
    return "confirmed";
  } catch (error) {
    if (!(error instanceof StaleBookingError)) throw error;
    // Someone else settled it first (a duplicate delivery racing this one).
    const current = await db
      .prepare("SELECT status FROM payments WHERE id = ?")
      .bind(payment.id)
      .first<{ status: string }>();
    if (current?.status === "paid" || current?.status === "mismatch") return "already_processed";
    throw error;
  }
}
