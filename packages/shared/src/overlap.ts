import { DomainError } from "./errors";
import type { DateString } from "./time";

/** A span of calendar days. Both ends are inclusive. */
export interface DateRange {
  from: DateString;
  to: DateString;
}

/** A span of time. `start` is inclusive, `end` is exclusive: [start, end). */
export interface Interval {
  start: Date;
  end: Date;
}

function assertOrdered(range: DateRange): void {
  if (range.to < range.from) {
    throw new DomainError("INVALID_DATE", "range end is before range start");
  }
}

/** Inclusive day ranges overlap when they share at least one calendar day. */
export function dateRangesOverlap(a: DateRange, b: DateRange): boolean {
  assertOrdered(a);
  assertOrdered(b);
  return a.from <= b.to && b.from <= a.to;
}

/** Half-open intervals overlap only when they share time; touching end-to-start does not count. */
export function intervalsOverlap(a: Interval, b: Interval): boolean {
  return a.start.getTime() < b.end.getTime() && b.start.getTime() < a.end.getTime();
}

/** The wanted days that are already taken, in the order they were asked for. */
export function conflictingDates(
  wanted: readonly DateString[],
  taken: Iterable<DateString>,
): DateString[] {
  const takenSet = new Set(taken);
  return wanted.filter((date) => takenSet.has(date));
}
