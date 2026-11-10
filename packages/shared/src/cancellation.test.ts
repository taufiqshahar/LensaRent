import { describe, expect, it } from "vitest";
import type { CancellationInput, CancellationSettings } from "./cancellation";
import { cancellationOutcome } from "./cancellation";
import { DEFAULT_SETTINGS } from "./defaultSettings";
import { DomainError } from "./errors";
import { MS_PER_HOUR, mytDateTime } from "./time";

const settings: CancellationSettings = DEFAULT_SETTINGS.cancellation;
const pickupAt = mytDateTime("2026-12-10", "09:00");
const before = (hours: number, extraMs = 0) =>
  new Date(pickupAt.getTime() - hours * MS_PER_HOUR - extraMs);

const base: CancellationInput = {
  pickupAt,
  cancelledAt: before(100),
  initiator: "customer",
  totalPaidSen: 16900, // RM69 rental + RM100 deposit
  gatewayFeeSen: 100,
  rescheduleUsed: false,
};

describe("cancellationOutcome", () => {
  it("refunds everything when the business cancels", () => {
    expect(
      cancellationOutcome({ ...base, initiator: "business", cancelledAt: before(1) }, settings),
    ).toEqual({
      tier: "BUSINESS",
      cancellationFeeSen: 0,
      gatewayFeeSen: 0,
      refundSen: 16900,
      rescheduleAllowed: false,
    });
  });

  it("gives a full refund less the gateway fee more than 72 hours ahead", () => {
    expect(cancellationOutcome(base, settings)).toEqual({
      tier: "FULL_REFUND",
      cancellationFeeSen: 0,
      gatewayFeeSen: 100,
      refundSen: 16800,
      rescheduleAllowed: false,
    });
    expect(cancellationOutcome({ ...base, cancelledAt: before(72, 1) }, settings).tier).toBe(
      "FULL_REFUND",
    );
  });

  it("offers a free date change or a refund less the fee from 24 to 72 hours ahead", () => {
    for (const cancelledAt of [before(72), before(48), before(24)]) {
      expect(cancellationOutcome({ ...base, cancelledAt }, settings)).toEqual({
        tier: "RESCHEDULE_OR_FEE",
        cancellationFeeSen: 3000,
        gatewayFeeSen: 0,
        refundSen: 13900,
        rescheduleAllowed: true,
      });
    }
  });

  it("only allows the free date change once", () => {
    const outcome = cancellationOutcome(
      { ...base, cancelledAt: before(48), rescheduleUsed: true },
      settings,
    );
    expect(outcome.tier).toBe("RESCHEDULE_OR_FEE");
    expect(outcome.rescheduleAllowed).toBe(false);
  });

  it("forfeits the fee under 24 hours ahead, and returns the rest including the deposit", () => {
    const expected = {
      tier: "FORFEIT_FEE",
      cancellationFeeSen: 3000,
      gatewayFeeSen: 0,
      refundSen: 13900,
      rescheduleAllowed: false,
    };
    expect(cancellationOutcome({ ...base, cancelledAt: before(24, -1) }, settings)).toEqual(
      expected,
    );
    expect(cancellationOutcome({ ...base, cancelledAt: before(-5) }, settings)).toEqual(expected);
  });

  it("treats a no-show as a forfeit whenever it is recorded", () => {
    expect(cancellationOutcome({ ...base, initiator: "no_show" }, settings).tier).toBe(
      "FORFEIT_FEE",
    );
  });

  it("never refunds a negative amount", () => {
    expect(
      cancellationOutcome({ ...base, cancelledAt: before(1), totalPaidSen: 2000 }, settings),
    ).toMatchObject({ cancellationFeeSen: 2000, refundSen: 0 });
    expect(cancellationOutcome({ ...base, gatewayFeeSen: 99999 }, settings)).toMatchObject({
      gatewayFeeSen: 16900,
      refundSen: 0,
    });
    expect(cancellationOutcome({ ...base, gatewayFeeSen: -50 }, settings)).toMatchObject({
      gatewayFeeSen: 0,
      refundSen: 16900,
    });
  });

  it("rejects float amounts", () => {
    expect(() => cancellationOutcome({ ...base, totalPaidSen: 169.5 }, settings)).toThrow(
      DomainError,
    );
    expect(() => cancellationOutcome({ ...base, gatewayFeeSen: 1.5 }, settings)).toThrow(
      DomainError,
    );
    expect(() => cancellationOutcome(base, { ...settings, feeSen: 30.5 })).toThrow(DomainError);
  });
});
