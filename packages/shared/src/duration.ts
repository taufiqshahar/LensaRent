import { DomainError } from "./errors";
import type { DateString } from "./time";
import { MS_PER_DAY, MS_PER_HOUR, addHours, eachDate, mytDateString } from "./time";

export interface PeakPeriod {
  /** First peak day (inclusive). */
  from: DateString;
  /** Last peak day (inclusive). */
  to: DateString;
  label?: string | undefined;
}

export interface BufferSettings {
  /** Turnaround hours kept free after a return on a normal day. */
  normalHours: number;
  /** Turnaround hours kept free after a return that falls in a peak period. */
  peakHours: number;
}

/** Billable days: every started 24-hour block counts, minimum one day. */
export function rentalDays(pickupAt: Date, returnAt: Date): number {
  const durationMs = returnAt.getTime() - pickupAt.getTime();
  if (!(durationMs > 0)) {
    throw new DomainError("INVALID_PERIOD", "return must be after pickup");
  }
  return Math.max(1, Math.ceil(durationMs / MS_PER_DAY));
}

export function isPeakDate(date: DateString, periods: readonly PeakPeriod[]): boolean {
  return periods.some((period) => period.from <= date && date <= period.to);
}

/** Buffer length for a return: the peak buffer applies when the return day is a peak day. */
export function bufferHoursFor(
  returnSlotEnd: Date,
  buffer: BufferSettings,
  peakPeriods: readonly PeakPeriod[],
): number {
  return isPeakDate(mytDateString(returnSlotEnd), peakPeriods)
    ? buffer.peakHours
    : buffer.normalHours;
}

export interface LockedDatesInput {
  pickupAt: Date;
  returnSlotEnd: Date;
  buffer: BufferSettings;
  peakPeriods: readonly PeakPeriod[];
}

/**
 * Calendar days (MYT) a booking occupies on its unit: from the pickup day through the day
 * the post-return buffer ends. The unit is free again at the buffer end itself, so a buffer
 * ending exactly at midnight does not lock the following day.
 */
export function lockedDates(input: LockedDatesInput): DateString[] {
  const { pickupAt, returnSlotEnd, buffer, peakPeriods } = input;
  if (!(returnSlotEnd.getTime() > pickupAt.getTime())) {
    throw new DomainError("INVALID_PERIOD", "return slot must end after pickup");
  }
  const bufferEnd = addHours(returnSlotEnd, bufferHoursFor(returnSlotEnd, buffer, peakPeriods));
  const lastOccupiedInstant = new Date(bufferEnd.getTime() - 1);
  return eachDate(mytDateString(pickupAt), mytDateString(lastOccupiedInstant));
}

export type PeriodViolation =
  "RETURN_NOT_AFTER_PICKUP" | "LEAD_TIME_TOO_SHORT" | "EXCEEDS_MAX_RENTAL_DAYS";

export interface RentalPeriodInput {
  now: Date;
  pickupAt: Date;
  returnAt: Date;
  minLeadHours: number;
  maxRentalDays: number;
}

/** Checks a requested rental period against booking rules. Returns the first violation, or null. */
export function validateRentalPeriod(input: RentalPeriodInput): PeriodViolation | null {
  const { now, pickupAt, returnAt, minLeadHours, maxRentalDays } = input;
  if (!(returnAt.getTime() > pickupAt.getTime())) return "RETURN_NOT_AFTER_PICKUP";
  if (pickupAt.getTime() - now.getTime() < minLeadHours * MS_PER_HOUR) return "LEAD_TIME_TOO_SHORT";
  if (rentalDays(pickupAt, returnAt) > maxRentalDays) return "EXCEEDS_MAX_RENTAL_DAYS";
  return null;
}
