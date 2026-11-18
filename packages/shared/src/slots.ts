import type { SlotKind } from "./schemas";
import type { DateString, TimeOfDay } from "./time";
import { dayOfWeek, mytDateTime } from "./time";

/**
 * Handover slots (settings `handoverSlots`). The business hands cameras over and takes
 * them back only in fixed slots, at fixed meetup locations.
 */
export interface HandoverSlot {
  id: string;
  label: string;
  /** 0 = Sunday … 6 = Saturday, in MYT. */
  daysOfWeek: readonly number[];
  startTime: TimeOfDay;
  endTime: TimeOfDay;
  kinds: readonly SlotKind[];
  locationIds: readonly string[];
  active: boolean;
}

export type SlotProblem =
  "UNKNOWN_SLOT" | "SLOT_NOT_FOR_KIND" | "SLOT_NOT_ON_DAY" | "LOCATION_NOT_SERVED";

export interface ResolvedSlot {
  slot: HandoverSlot;
  start: Date;
  end: Date;
}

/** The active slots offered on a given day for pickup or return, earliest first. */
export function slotsOn(
  slots: readonly HandoverSlot[],
  date: DateString,
  kind: SlotKind,
): HandoverSlot[] {
  const day = dayOfWeek(date);
  return slots
    .filter((slot) => slot.active && slot.kinds.includes(kind) && slot.daysOfWeek.includes(day))
    .sort((a, b) => a.startTime.localeCompare(b.startTime));
}

/** Turns "slot X on day D at location L" into real instants, or says why it cannot. */
export function resolveSlot(
  slots: readonly HandoverSlot[],
  request: { date: DateString; slotId: string; kind: SlotKind; locationId: string },
): { ok: true; value: ResolvedSlot } | { ok: false; problem: SlotProblem } {
  const slot = slots.find((candidate) => candidate.id === request.slotId && candidate.active);
  if (!slot) return { ok: false, problem: "UNKNOWN_SLOT" };
  if (!slot.kinds.includes(request.kind)) return { ok: false, problem: "SLOT_NOT_FOR_KIND" };
  if (!slot.daysOfWeek.includes(dayOfWeek(request.date))) {
    return { ok: false, problem: "SLOT_NOT_ON_DAY" };
  }
  if (!slot.locationIds.includes(request.locationId)) {
    return { ok: false, problem: "LOCATION_NOT_SERVED" };
  }
  return {
    ok: true,
    value: {
      slot,
      start: mytDateTime(request.date, slot.startTime),
      end: mytDateTime(request.date, slot.endTime),
    },
  };
}
