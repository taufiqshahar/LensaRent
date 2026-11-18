import { describe, expect, it } from "vitest";
import { BOOKING_STATUS_HELP, BOOKING_STATUS_LABELS, LEDGER_TYPE_LABELS } from "./bookingLabels";
import { LEDGER_ENTRY_TYPES } from "./ledger";
import { BOOKING_STATUSES } from "./stateMachine";

describe("booking labels", () => {
  it("name every status and every ledger type", () => {
    for (const status of BOOKING_STATUSES) {
      expect(BOOKING_STATUS_LABELS[status]).toBeTruthy();
      expect(BOOKING_STATUS_HELP[status]).toBeTruthy();
    }
    for (const type of LEDGER_ENTRY_TYPES) expect(LEDGER_TYPE_LABELS[type]).toBeTruthy();
  });
});
