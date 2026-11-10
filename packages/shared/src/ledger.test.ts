import { describe, expect, it } from "vitest";
import { DomainError } from "./errors";
import { DEPOSIT_ENTRY_TYPES, LEDGER_ENTRY_TYPES, depositBalanceSen } from "./ledger";

describe("ledger entry types", () => {
  it("match the specification", () => {
    expect(LEDGER_ENTRY_TYPES).toEqual([
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
    ]);
    expect(DEPOSIT_ENTRY_TYPES).toEqual(["DEPOSIT_IN", "DEPOSIT_REFUND", "DEPOSIT_DEDUCTION"]);
  });
});

describe("depositBalanceSen", () => {
  it("is zero with no entries", () => {
    expect(depositBalanceSen([])).toBe(0);
  });

  it("is the deposit while it is still held", () => {
    expect(
      depositBalanceSen([
        { type: "RENTAL", amountSen: 6900 },
        { type: "DEPOSIT_IN", amountSen: 10000 },
      ]),
    ).toBe(10000);
  });

  it("reaches zero after a full refund", () => {
    expect(
      depositBalanceSen([
        { type: "DEPOSIT_IN", amountSen: 10000 },
        { type: "DEPOSIT_REFUND", amountSen: -10000 },
      ]),
    ).toBe(0);
  });

  it("reaches zero after a deduction plus a partial refund", () => {
    expect(
      depositBalanceSen([
        { type: "DEPOSIT_IN", amountSen: 10000 },
        { type: "LATE_FEE", amountSen: 1500 },
        { type: "DEPOSIT_DEDUCTION", amountSen: -1500 },
        { type: "DEPOSIT_REFUND", amountSen: -8500 },
      ]),
    ).toBe(0);
  });

  it("counts reversing entries", () => {
    expect(
      depositBalanceSen([
        { type: "DEPOSIT_IN", amountSen: 10000 },
        { type: "DEPOSIT_REFUND", amountSen: -10000 },
        { type: "DEPOSIT_REFUND", amountSen: 10000 }, // reversal of a refund recorded by mistake
      ]),
    ).toBe(10000);
  });

  it("ignores entries that are not about the deposit", () => {
    expect(
      depositBalanceSen([
        { type: "RENTAL", amountSen: 6900 },
        { type: "ADD_ON", amountSen: 500 },
        { type: "REFUND", amountSen: -7400 },
        { type: "GATEWAY_FEE", amountSen: -100 },
      ]),
    ).toBe(0);
  });

  it("rejects float amounts", () => {
    expect(() => depositBalanceSen([{ type: "DEPOSIT_IN", amountSen: 100.5 }])).toThrow(
      DomainError,
    );
  });
});
