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

/**
 * Sign of each entry type: +1 for money the business takes in or keeps, -1 for money that
 * goes out or is given away. A reversal carries the opposite sign of its type and names
 * the entry it reverses. The database enforces the same rule (migrations/0002).
 */
export const LEDGER_SIGN: Readonly<Record<LedgerEntryType, 1 | -1>> = {
  RENTAL: 1,
  ADD_ON: 1,
  MEETUP_FEE: 1,
  DISCOUNT: -1,
  DEPOSIT_IN: 1,
  DEPOSIT_REFUND: -1,
  DEPOSIT_DEDUCTION: -1,
  LATE_FEE: 1,
  DAMAGE_CHARGE: 1,
  CANCELLATION_FEE: 1,
  REFUND: -1,
  GATEWAY_FEE: -1,
};

/** True when `amountSen` has the sign its type requires (or the opposite, for a reversal). */
export function hasLedgerSign(type: LedgerEntryType, amountSen: Sen, reversal = false): boolean {
  if (!Number.isSafeInteger(amountSen) || amountSen === 0) return false;
  const expected = reversal ? -LEDGER_SIGN[type] : LEDGER_SIGN[type];
  return Math.sign(amountSen) === expected;
}
