import { describe, expect, it } from "vitest";
import type { ActorType, BookingStatus } from "./stateMachine";
import {
  ACTOR_TYPES,
  BOOKING_STATUSES,
  STATUSES_REQUIRING_SETTLED_DEPOSIT,
  TERMINAL_STATUSES,
  TRANSITIONS,
  allowedTransitions,
  canTransition,
  isTerminal,
} from "./stateMachine";

/** Master prompt §7, written out independently of the implementation table. */
const ALLOWED = new Set([
  "pending_payment>confirmed:webhook",
  "pending_payment>cancelled:system",
  "pending_payment>cancelled:admin",
  "pending_payment>refund_pending:webhook",
  "confirmed>ready_for_pickup:admin",
  "confirmed>refund_pending:admin",
  "ready_for_pickup>active_rental:admin",
  "ready_for_pickup>refund_pending:admin",
  "active_rental>return_inspection:admin",
  "active_rental>overdue:system",
  "overdue>return_inspection:admin",
  "overdue>disputed:admin",
  "return_inspection>completed:admin",
  "return_inspection>disputed:admin",
  "disputed>completed:admin",
  "refund_pending>refunded:admin",
]);

describe("canTransition", () => {
  const combinations: [BookingStatus, BookingStatus, ActorType][] = BOOKING_STATUSES.flatMap(
    (from) =>
      BOOKING_STATUSES.flatMap((to) =>
        ACTOR_TYPES.map((actor) => [from, to, actor] as [BookingStatus, BookingStatus, ActorType]),
      ),
  );

  it("covers every status × status × actor combination", () => {
    expect(combinations).toHaveLength(11 * 11 * 3);
  });

  it.each(combinations)("%s → %s by %s", (from, to, actor) => {
    expect(canTransition(from, to, actor)).toBe(ALLOWED.has(`${from}>${to}:${actor}`));
  });

  it("allows exactly the transitions in the specification", () => {
    const implemented = TRANSITIONS.flatMap((transition) =>
      transition.actors.map((actor) => `${transition.from}>${transition.to}:${actor}`),
    );
    expect(new Set(implemented)).toEqual(ALLOWED);
    expect(implemented).toHaveLength(ALLOWED.size);
  });

  it("never lets a customer-facing shortcut skip payment or inspection", () => {
    expect(canTransition("pending_payment", "completed", "admin")).toBe(false);
    expect(canTransition("pending_payment", "confirmed", "admin")).toBe(false);
    expect(canTransition("confirmed", "completed", "admin")).toBe(false);
    expect(canTransition("active_rental", "completed", "admin")).toBe(false);
  });
});

describe("terminal statuses", () => {
  it("are completed, refunded and cancelled", () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual(["cancelled", "completed", "refunded"]);
    for (const status of BOOKING_STATUSES) {
      expect(isTerminal(status)).toBe(TERMINAL_STATUSES.includes(status));
    }
  });

  it("have no way out, for any actor", () => {
    for (const status of TERMINAL_STATUSES) {
      for (const actor of ACTOR_TYPES) {
        expect(allowedTransitions(status, actor)).toEqual([]);
      }
    }
  });

  it("are the only dead ends", () => {
    for (const status of BOOKING_STATUSES) {
      const hasExit = TRANSITIONS.some((transition) => transition.from === status);
      expect(hasExit).toBe(!isTerminal(status));
    }
  });
});

describe("allowedTransitions", () => {
  it("lists the next statuses for an actor", () => {
    expect(allowedTransitions("confirmed", "admin")).toEqual([
      "ready_for_pickup",
      "refund_pending",
    ]);
    expect(allowedTransitions("pending_payment", "webhook")).toEqual([
      "confirmed",
      "refund_pending",
    ]);
    expect(allowedTransitions("active_rental", "system")).toEqual(["overdue"]);
    expect(allowedTransitions("active_rental", "webhook")).toEqual([]);
  });
});

describe("graph shape", () => {
  it("can reach every status from pending_payment", () => {
    const reached = new Set<BookingStatus>(["pending_payment"]);
    const queue: BookingStatus[] = ["pending_payment"];
    for (let current = queue.shift(); current !== undefined; current = queue.shift()) {
      for (const transition of TRANSITIONS) {
        if (transition.from === current && !reached.has(transition.to)) {
          reached.add(transition.to);
          queue.push(transition.to);
        }
      }
    }
    expect([...reached].sort()).toEqual([...BOOKING_STATUSES].sort());
  });

  it("requires a settled deposit before completion", () => {
    expect(STATUSES_REQUIRING_SETTLED_DEPOSIT).toEqual(["completed"]);
  });
});
