import { DomainError } from "./errors";

/**
 * Time helpers. The business runs on Malaysia time (MYT): a fixed UTC+8 offset with no DST.
 * Instants are `Date` objects (UTC underneath); calendar days are `yyyy-MM-dd` strings in MYT.
 * Always go through these helpers — never read local-time getters such as `getHours()`.
 */
export const MYT_TIME_ZONE = "Asia/Kuala_Lumpur";

export const MS_PER_MINUTE = 60_000;
export const MS_PER_HOUR = 60 * MS_PER_MINUTE;
export const MS_PER_DAY = 24 * MS_PER_HOUR;
export const MYT_OFFSET_MS = 8 * MS_PER_HOUR;

/** A calendar day in MYT, formatted `yyyy-MM-dd`. Lexicographic order equals chronological order. */
export type DateString = string;
/** A wall-clock time in MYT, formatted `HH:mm` (24-hour). */
export type TimeOfDay = string;

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

function utcMidnightMs(date: DateString): number {
  const match = DATE_PATTERN.exec(date);
  if (!match) throw new DomainError("INVALID_DATE", "date must be formatted yyyy-MM-dd");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const ms = Date.UTC(year, month - 1, day);
  const roundTrip = new Date(ms);
  // Date.UTC silently rolls over impossible dates (2026-02-30 → 2 March); reject those.
  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() !== month - 1 ||
    roundTrip.getUTCDate() !== day
  ) {
    throw new DomainError("INVALID_DATE", "date is not a real calendar day");
  }
  return ms;
}

function assertInstant(instant: Date): void {
  if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) {
    throw new DomainError("INVALID_DATE", "instant must be a valid Date");
  }
}

export function isDateString(value: unknown): value is DateString {
  if (typeof value !== "string") return false;
  try {
    utcMidnightMs(value);
    return true;
  } catch {
    return false;
  }
}

export function isTimeOfDay(value: unknown): value is TimeOfDay {
  return typeof value === "string" && TIME_PATTERN.test(value);
}

/** The MYT calendar day that contains the given instant. */
export function mytDateString(instant: Date): DateString {
  assertInstant(instant);
  return new Date(instant.getTime() + MYT_OFFSET_MS).toISOString().slice(0, 10);
}

/** The instant at which the MYT wall clock shows `date` `time`. */
export function mytDateTime(date: DateString, time: TimeOfDay = "00:00"): Date {
  const match = TIME_PATTERN.exec(time);
  if (!match) throw new DomainError("INVALID_DATE", "time must be formatted HH:mm");
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return new Date(utcMidnightMs(date) + minutes * MS_PER_MINUTE - MYT_OFFSET_MS);
}

export function addDays(date: DateString, days: number): DateString {
  if (!Number.isSafeInteger(days)) {
    throw new DomainError("INVALID_DATE", "days must be an integer");
  }
  return new Date(utcMidnightMs(date) + days * MS_PER_DAY).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function diffDays(from: DateString, to: DateString): number {
  return Math.round((utcMidnightMs(to) - utcMidnightMs(from)) / MS_PER_DAY);
}

/** Upper bound for `eachDate`, so a bad range can never produce an unbounded list. */
export const MAX_DATE_RANGE_DAYS = 366;

/** Every calendar day from `from` to `to`, both inclusive. */
export function eachDate(from: DateString, to: DateString): DateString[] {
  const count = diffDays(from, to) + 1;
  if (count < 1) throw new DomainError("INVALID_DATE", "range end is before range start");
  if (count > MAX_DATE_RANGE_DAYS) {
    throw new DomainError(
      "INVALID_DATE",
      `range is longer than ${MAX_DATE_RANGE_DAYS.toString()} days`,
    );
  }
  return Array.from({ length: count }, (_, index) => addDays(from, index));
}

export function addHours(instant: Date, hours: number): Date {
  assertInstant(instant);
  return new Date(instant.getTime() + hours * MS_PER_HOUR);
}

export function addMinutes(instant: Date, minutes: number): Date {
  assertInstant(instant);
  return new Date(instant.getTime() + minutes * MS_PER_MINUTE);
}

/** Day of week for an MYT calendar day: 0 = Sunday … 6 = Saturday. */
export function dayOfWeek(date: DateString): number {
  return new Date(utcMidnightMs(date)).getUTCDay();
}

/** Human-readable MYT date and time for UI and email (Bahasa Melayu by default). */
export function formatMytDateTime(instant: Date, locale = "ms-MY"): string {
  assertInstant(instant);
  return new Intl.DateTimeFormat(locale, {
    timeZone: MYT_TIME_ZONE,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(instant);
}

/** Human-readable MYT calendar day for UI and email (Bahasa Melayu by default). */
export function formatMytDate(date: DateString, locale = "ms-MY"): string {
  return new Intl.DateTimeFormat(locale, { timeZone: MYT_TIME_ZONE, dateStyle: "medium" }).format(
    mytDateTime(date, "12:00"),
  );
}
