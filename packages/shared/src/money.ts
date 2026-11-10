import { DomainError } from "./errors";

/**
 * All money in the system is an integer number of sen (1 RM = 100 sen).
 * Floats never enter: every arithmetic helper here rejects non-integers and unsafe integers.
 */
export type Sen = number;

export function isSen(value: unknown): value is Sen {
  return typeof value === "number" && Number.isSafeInteger(value);
}

export function assertSen(value: unknown, label = "amount"): asserts value is Sen {
  if (!isSen(value)) {
    throw new DomainError("INVALID_AMOUNT", `${label} must be a safe integer number of sen`);
  }
}

export function sumSen(values: readonly Sen[]): Sen {
  let total = 0;
  for (const value of values) {
    assertSen(value);
    total += value;
  }
  assertSen(total, "sum");
  return total;
}

export function multiplySen(unitSen: Sen, quantity: number): Sen {
  assertSen(unitSen, "unit price");
  if (!Number.isSafeInteger(quantity) || quantity < 0) {
    throw new DomainError("INVALID_AMOUNT", "quantity must be a non-negative integer");
  }
  const total = unitSen * quantity;
  assertSen(total, "product");
  return total;
}

/** Formats sen for display, e.g. 6900 → "RM69.00", -3000 → "-RM30.00", 123456 → "RM1,234.56". */
export function formatRM(sen: Sen): string {
  assertSen(sen);
  const abs = Math.abs(sen);
  const cents = abs % 100;
  // (abs - cents) is an exact multiple of 100, so this division is exact (no float rounding).
  const ringgit = (abs - cents) / 100;
  const grouped = String(ringgit).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sen < 0 ? "-" : ""}RM${grouped}.${String(cents).padStart(2, "0")}`;
}
