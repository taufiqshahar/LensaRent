import type { Sen } from "./money";
import { assertSen } from "./money";
import { MS_PER_HOUR } from "./time";

export interface CancellationSettings {
  /** Cancelling MORE than this many hours before pickup gives a full refund. */
  fullRefundAboveHours: number;
  /** From this many hours before pickup (inclusive) up to the full-refund line: reschedule or fee. */
  feeWindowFromHours: number;
  /** Fee kept when a refund is given inside the fee window, or forfeited on a late cancel. */
  feeSen: Sen;
}

export type CancellationInitiator = "customer" | "business" | "no_show";

export type CancellationTier =
  /** More than 72h before pickup: everything back, less the gateway's actual fee. */
  | "FULL_REFUND"
  /** 24–72h before pickup: one free date change, or a refund less the fee. */
  | "RESCHEDULE_OR_FEE"
  /** Under 24h, or a no-show: the fee is forfeited, the rest (including deposit) goes back. */
  | "FORFEIT_FEE"
  /** Cancelled by the business: everything back, nothing deducted. */
  | "BUSINESS";

export interface CancellationInput {
  pickupAt: Date;
  cancelledAt: Date;
  initiator: CancellationInitiator;
  /** Everything the customer paid for the booking, including the deposit. */
  totalPaidSen: Sen;
  /** The payment gateway's actual fee for the original payment. */
  gatewayFeeSen: Sen;
  /** Whether the booking's one free date change has already been used. */
  rescheduleUsed: boolean;
}

export interface CancellationOutcome {
  tier: CancellationTier;
  /** Recorded as `CANCELLATION_FEE` when the customer takes the refund. */
  cancellationFeeSen: Sen;
  /** Recorded as `GATEWAY_FEE`; only deducted on a full refund. */
  gatewayFeeSen: Sen;
  /** Amount to send back to the customer if they take the refund. */
  refundSen: Sen;
  /** True when the customer may change the date for free instead of taking the refund. */
  rescheduleAllowed: boolean;
}

/**
 * Works out what a cancellation costs. Computed on the server and shown to the customer
 * before payment; the refund itself is sent manually by an admin and then recorded.
 */
export function cancellationOutcome(
  input: CancellationInput,
  settings: CancellationSettings,
): CancellationOutcome {
  const { totalPaidSen, initiator } = input;
  assertSen(totalPaidSen, "total paid");
  assertSen(input.gatewayFeeSen, "gateway fee");
  assertSen(settings.feeSen, "cancellation fee");

  if (initiator === "business") {
    return {
      tier: "BUSINESS",
      cancellationFeeSen: 0,
      gatewayFeeSen: 0,
      refundSen: totalPaidSen,
      rescheduleAllowed: false,
    };
  }

  const hoursBeforePickup = (input.pickupAt.getTime() - input.cancelledAt.getTime()) / MS_PER_HOUR;

  if (initiator === "customer" && hoursBeforePickup > settings.fullRefundAboveHours) {
    const gatewayFeeSen = Math.min(Math.max(input.gatewayFeeSen, 0), totalPaidSen);
    return {
      tier: "FULL_REFUND",
      cancellationFeeSen: 0,
      gatewayFeeSen,
      refundSen: totalPaidSen - gatewayFeeSen,
      rescheduleAllowed: false,
    };
  }

  const cancellationFeeSen = Math.min(settings.feeSen, totalPaidSen);
  const insideFeeWindow =
    initiator === "customer" && hoursBeforePickup >= settings.feeWindowFromHours;

  return {
    tier: insideFeeWindow ? "RESCHEDULE_OR_FEE" : "FORFEIT_FEE",
    cancellationFeeSen,
    gatewayFeeSen: 0,
    refundSen: totalPaidSen - cancellationFeeSen,
    rescheduleAllowed: insideFeeWindow && !input.rescheduleUsed,
  };
}
