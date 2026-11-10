import { DomainError } from "./errors";
import type { Sen } from "./money";
import { assertSen, multiplySen } from "./money";
import { MS_PER_DAY, MS_PER_HOUR, MS_PER_MINUTE } from "./time";

export interface LateFeeSettings {
  /** Minutes after the return slot ends during which a late return is not charged. */
  graceMinutes: number;
  /** Length of one chargeable block, in hours. */
  blockHours: number;
  /** Fee for each started block. */
  perBlockSen: Sen;
  /** Most that can be charged for any 24 hours of lateness. */
  capPer24hSen: Sen;
}

/** True once the grace period after the return slot has fully passed. */
export function isOverdue(returnSlotEnd: Date, now: Date, graceMinutes: number): boolean {
  return now.getTime() > returnSlotEnd.getTime() + graceMinutes * MS_PER_MINUTE;
}

/**
 * Suggested late fee. Lateness is measured from the end of the return slot; nothing is
 * charged within the grace period. After that every started block is charged, capped per
 * 24 hours. This is only a suggestion: an admin must approve it before it becomes a
 * `LATE_FEE` ledger entry.
 */
export function lateFeeSen(returnSlotEnd: Date, returnedAt: Date, settings: LateFeeSettings): Sen {
  const { graceMinutes, blockHours, perBlockSen, capPer24hSen } = settings;
  assertSen(perBlockSen, "late fee per block");
  assertSen(capPer24hSen, "late fee cap");
  if (!(blockHours > 0)) {
    throw new DomainError("INVALID_SETTINGS", "late fee block length must be positive");
  }

  const lateMs = returnedAt.getTime() - returnSlotEnd.getTime();
  if (!(lateMs > graceMinutes * MS_PER_MINUTE)) return 0;

  const blockMs = blockHours * MS_PER_HOUR;
  const fullDays = Math.floor(lateMs / MS_PER_DAY);
  const remainderMs = lateMs - fullDays * MS_PER_DAY;

  const fullDaySen = Math.min(
    multiplySen(perBlockSen, Math.ceil(MS_PER_DAY / blockMs)),
    capPer24hSen,
  );
  const remainderSen = Math.min(
    multiplySen(perBlockSen, Math.ceil(remainderMs / blockMs)),
    capPer24hSen,
  );
  return multiplySen(fullDaySen, fullDays) + remainderSen;
}
