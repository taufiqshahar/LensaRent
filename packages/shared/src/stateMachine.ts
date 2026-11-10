/**
 * Booking state machine (master prompt §7). This table is the single definition of which
 * status changes exist and who may make them. The UI uses it to show valid actions; the
 * Worker uses it to reject everything else before writing. Firestore enforces nothing.
 */
export const BOOKING_STATUSES = [
  "pending_payment",
  "confirmed",
  "ready_for_pickup",
  "active_rental",
  "overdue",
  "return_inspection",
  "disputed",
  "refund_pending",
  "completed",
  "refunded",
  "cancelled",
] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export const ACTOR_TYPES = ["system", "admin", "webhook"] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export interface Transition {
  from: BookingStatus;
  to: BookingStatus;
  actors: readonly ActorType[];
}

export const TRANSITIONS: readonly Transition[] = [
  { from: "pending_payment", to: "confirmed", actors: ["webhook"] },
  { from: "pending_payment", to: "cancelled", actors: ["system", "admin"] },
  { from: "pending_payment", to: "refund_pending", actors: ["webhook"] },
  { from: "confirmed", to: "ready_for_pickup", actors: ["admin"] },
  { from: "confirmed", to: "refund_pending", actors: ["admin"] },
  { from: "ready_for_pickup", to: "active_rental", actors: ["admin"] },
  { from: "ready_for_pickup", to: "refund_pending", actors: ["admin"] },
  { from: "active_rental", to: "return_inspection", actors: ["admin"] },
  { from: "active_rental", to: "overdue", actors: ["system"] },
  { from: "overdue", to: "return_inspection", actors: ["admin"] },
  { from: "overdue", to: "disputed", actors: ["admin"] },
  { from: "return_inspection", to: "completed", actors: ["admin"] },
  { from: "return_inspection", to: "disputed", actors: ["admin"] },
  { from: "disputed", to: "completed", actors: ["admin"] },
  { from: "refund_pending", to: "refunded", actors: ["admin"] },
];

export const TERMINAL_STATUSES: readonly BookingStatus[] = ["completed", "refunded", "cancelled"];

/** Transitions into these statuses require the deposit balance to be exactly zero first. */
export const STATUSES_REQUIRING_SETTLED_DEPOSIT: readonly BookingStatus[] = ["completed"];

export function canTransition(from: BookingStatus, to: BookingStatus, actor: ActorType): boolean {
  return TRANSITIONS.some(
    (transition) =>
      transition.from === from && transition.to === to && transition.actors.includes(actor),
  );
}

/** Statuses the given actor may move a booking to from `from`. */
export function allowedTransitions(from: BookingStatus, actor: ActorType): BookingStatus[] {
  return TRANSITIONS.filter(
    (transition) => transition.from === from && transition.actors.includes(actor),
  ).map((transition) => transition.to);
}

export function isTerminal(status: BookingStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}
