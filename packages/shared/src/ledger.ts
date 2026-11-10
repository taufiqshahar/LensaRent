import type { Sen } from "./money";
import { sumSen } from "./money";

/**
 * Ledger entries are append-only. A mistake is corrected by adding a reversing entry,
 * never by editing or deleting one.
 */
export const LEDGER_ENTRY_TYPES = [
  "RENTAL",
  "ADD_ON",
  "MEETUP_FEE",
  "DISCOUNT",
  "DEPOSIT_IN",
  "DEPOSIT_REFUND",
  "DEPOSIT_DEDUCTION",
  "LATE_FEE",
  "DAMAGE_CHARGE",
  "CANCELLATION_FEE",
  "REFUND",
  "GATEWAY_FEE",
] as const;
export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPES)[number];

/** The entry types that move the security deposit, which is a liability and not revenue. */
export const DEPOSIT_ENTRY_TYPES: readonly LedgerEntryType[] = [
  "DEPOSIT_IN",
  "DEPOSIT_REFUND",
  "DEPOSIT_DEDUCTION",
];

export interface LedgerAmount {
  type: LedgerEntryType;
  /** Signed: deposit received is positive; refunds and deductions are negative. */
  amountSen: Sen;
}

/**
 * Deposit still held for a booking: the signed sum of its deposit entries.
 * A booking may only be completed once this is exactly zero.
 */
export function depositBalanceSen(entries: readonly LedgerAmount[]): Sen {
  return sumSen(
    entries
      .filter((entry) => DEPOSIT_ENTRY_TYPES.includes(entry.type))
      .map((entry) => entry.amountSen),
  );
}
