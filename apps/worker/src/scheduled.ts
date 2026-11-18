import type { AllSettings } from "@lensarent/shared";
import { addDays, addMinutes, mytDateString, mytDateTime, mytTimeOfDay } from "@lensarent/shared";
import type { Actor } from "./lib/bookings";
import { StaleBookingError, prepareTransition, runTransition } from "./lib/bookings";
import { PaymentProviderError } from "./lib/chip";
import type { AppConfig } from "./lib/env";
import { renderEmail } from "./lib/emails";
import { cancelHold } from "./lib/holds";
import type { Logger } from "./lib/logger";
import type { EmailTemplate } from "./lib/outbox";
import { EMAIL_TEMPLATES, outboxStatement } from "./lib/outbox";
import { EmailSendError } from "./lib/resend";
import type { PaymentRow } from "./lib/settlement";
import { settlePayment } from "./lib/settlement";
import type { Services } from "./services";

/**
 * The Worker's one cron trigger (`* * * * *`, ADR-005) runs every job below in turn.
 * Each job is idempotent and bounded, so an overlapping or repeated run is harmless, and
 * one failing job never stops the others.
 */
export const CRON_ACTOR: Actor = { type: "system", id: "system:cron" };

/** CHIP refuses payment at `due`; this margin covers clock differences between us. */
export const HOLD_GRACE_MINUTES = 2;
/** A hold still unresolved this long after expiry is escalated to the admin. */
export const HOLD_ALERT_AFTER_MINUTES = 30;
/** Rows handled per job per run; the next minute picks up the rest. */
const BATCH = 20;
/** Email delivery attempts before a message is marked failed. */
export const MAX_EMAIL_ATTEMPTS = 6;
/** Sent emails and processed webhook records are kept this long, then deleted. */
export const RECORD_RETENTION_DAYS = 90;
/** CHIP statuses in which a purchase can no longer be paid. */
const UNPAYABLE_STATUSES = new Set(["cancelled", "expired", "error", "blocked"]);

export interface JobContext {
  config: AppConfig;
  services: Services;
  settings: AllSettings;
  logger: Logger;
  now: Date;
}

export type HoldOutcome = "cancelled" | "settled" | "pending" | "unresolved";

/**
 * One expired hold. The order is what keeps a paid hold from losing its dates: ask CHIP
 * first; settle if paid; free the dates only once CHIP says the purchase cannot be paid.
 */
export async function resolveExpiredHold(
  context: JobContext,
  booking: { id: string; hold_expires_at: string },
): Promise<HoldOutcome> {
  const { services, config, logger, now } = context;
  const db = services.db;
  const payment = await db
    .prepare(
      `SELECT id, booking_id, provider_ref, expected_sen, status, is_test FROM payments
       WHERE booking_id = ? AND status = 'created' ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(booking.id)
    .first<PaymentRow>();
  const pending = { id: booking.id, status: "pending_payment" as const };

  try {
    if (!payment) {
      // No purchase was ever recorded for it, so nothing can be paid.
      await cancelHold(db, pending, "hold_expired", CRON_ACTOR, now);
      return "cancelled";
    }
    const provider = services.payments;
    if (!provider) return "unresolved";

    const state = await provider.fetchPayment(payment.provider_ref);
    if (state.paid) {
      await settlePayment(
        {
          db,
          logger,
          production: config.environment === "production",
          alertEmails: config.alertEmails,
          now,
        },
        payment,
        state,
      );
      return "settled";
    }
    if (state.status.startsWith("pending_")) return "pending";
    if (UNPAYABLE_STATUSES.has(state.status) || (await provider.cancel(payment.provider_ref))) {
      await cancelHold(db, pending, "hold_expired", CRON_ACTOR, now);
      return "cancelled";
    }
    return "unresolved";
  } catch (error) {
    if (error instanceof StaleBookingError) return "cancelled"; // Settled elsewhere meanwhile.
    if (!(error instanceof PaymentProviderError)) throw error;
    logger.warn("cron.hold_unreachable", { bookingId: booking.id });
    return "unresolved";
  }
}

function alertsStatements(
  context: JobContext,
  template: EmailTemplate,
  bookingId: string,
  guard: { sql: string; params: readonly string[] } | null,
): D1PreparedStatement[] {
  return context.config.alertEmails.map((to) =>
    outboxStatement(context.services.db, guard, {
      template,
      to,
      payload: { bookingId },
      dedupeKey: `${template}:${bookingId}:${to}`,
      sendAfter: context.now,
      createdAt: context.now,
    }),
  );
}

export async function expireHolds(context: JobContext): Promise<Record<HoldOutcome, number>> {
  const { services, now } = context;
  const { results } = await services.db
    .prepare(
      `SELECT id, hold_expires_at FROM bookings
       WHERE status = 'pending_payment' AND hold_expires_at <= ?
       ORDER BY hold_expires_at LIMIT ?`,
    )
    .bind(addMinutes(now, -HOLD_GRACE_MINUTES).toISOString(), BATCH)
    .all<{ id: string; hold_expires_at: string }>();

  const counts: Record<HoldOutcome, number> = {
    cancelled: 0,
    settled: 0,
    pending: 0,
    unresolved: 0,
  };
  for (const booking of results) {
    const outcome = await resolveExpiredHold(context, booking);
    counts[outcome]++;
    const lateBy = now.getTime() - Date.parse(booking.hold_expires_at);
    if (outcome === "unresolved" && lateBy >= HOLD_ALERT_AFTER_MINUTES * 60_000) {
      await services.db.batch(alertsStatements(context, "admin_hold_unresolved", booking.id, null));
    }
  }
  return counts;
}

/** Active rentals past their return slot plus the grace period become `overdue`. */
export async function markOverdue(context: JobContext): Promise<number> {
  const { services, settings, now, logger } = context;
  const db = services.db;
  const { results } = await db
    .prepare(
      `SELECT id, status FROM bookings WHERE status = 'active_rental' AND return_slot_end <= ?
       ORDER BY return_slot_end LIMIT ?`,
    )
    .bind(addMinutes(now, -settings.lateFee.graceMinutes).toISOString(), BATCH)
    .all<{ id: string; status: "active_rental" }>();

  let marked = 0;
  for (const booking of results) {
    try {
      const prepared = prepareTransition(
        db,
        booking,
        { to: "overdue", actor: CRON_ACTOR, reason: "return_slot_passed", now },
        (guard) => alertsStatements(context, "admin_overdue", booking.id, guard),
      );
      await runTransition(db, prepared);
      marked++;
      logger.warn("booking.overdue", { bookingId: booking.id });
    } catch (error) {
      if (!(error instanceof StaleBookingError)) throw error;
    }
  }
  return marked;
}

/** Queues the morning summary (08:00 MYT hour) and next-day reminders (18:00 MYT hour). */
export async function queueDailyMessages(context: JobContext): Promise<number> {
  const { services, config, now } = context;
  const db = services.db;
  const hour = mytTimeOfDay(now).slice(0, 2);
  const today = mytDateString(now);
  const statements: D1PreparedStatement[] = [];

  // Queued every minute of the hour, sent once: the dedupe key makes the repeats no-ops.
  if (hour === "08") {
    for (const to of config.alertEmails) {
      statements.push(
        outboxStatement(db, null, {
          template: "admin_daily_summary",
          to,
          payload: { date: today },
          dedupeKey: `admin_daily_summary:${today}:${to}`,
          sendAfter: now,
          createdAt: now,
        }),
      );
    }
  }
  if (hour === "18") {
    const tomorrow = addDays(today, 1);
    const { results } = await db
      .prepare(
        `SELECT id, customer_email FROM bookings
         WHERE status IN ('confirmed', 'ready_for_pickup') AND pickup_at >= ? AND pickup_at < ?`,
      )
      .bind(mytDateTime(tomorrow).toISOString(), mytDateTime(addDays(tomorrow, 1)).toISOString())
      .all<{ id: string; customer_email: string }>();
    for (const booking of results) {
      statements.push(
        outboxStatement(db, null, {
          template: "pickup_reminder",
          to: booking.customer_email,
          payload: { bookingId: booking.id },
          dedupeKey: `pickup_reminder:${booking.id}`,
          sendAfter: now,
          createdAt: now,
        }),
      );
    }
  }
  if (statements.length === 0) return 0;
  const results = await db.batch(statements);
  return results.reduce((sum, result) => sum + result.meta.changes, 0);
}

interface OutboxRow {
  id: string;
  template: string;
  to_address: string;
  payload: string;
  attempts: number;
}

function isTemplate(value: string): value is EmailTemplate {
  return (EMAIL_TEMPLATES as readonly string[]).includes(value);
}

/** Sends due emails. Without a mailer configured, messages simply wait in the queue. */
export async function sendOutbox(context: JobContext): Promise<{ sent: number; failed: number }> {
  const { services, config, settings, logger, now } = context;
  const mailer = services.mailer;
  const counts = { sent: 0, failed: 0 };
  if (!mailer) return counts;
  const db = services.db;
  const { results } = await db
    .prepare(
      `SELECT id, template, to_address, payload, attempts FROM notifications_outbox
       WHERE status = 'pending' AND send_after <= ? ORDER BY send_after LIMIT ?`,
    )
    .bind(now.toISOString(), BATCH)
    .all<OutboxRow>();

  const finish = (id: string, status: "sent" | "failed", error: string | null) =>
    db
      .prepare(
        `UPDATE notifications_outbox SET status = ?, attempts = attempts + 1, last_error = ?,
           sent_at = ? WHERE id = ? AND status = 'pending'`,
      )
      .bind(status, error, status === "sent" ? now.toISOString() : null, id)
      .run();

  for (const row of results) {
    const rendered = isTemplate(row.template)
      ? await renderEmail(
          { db, hasher: services.hasher, settings, siteOrigin: config.siteOrigin },
          row.template,
          JSON.parse(row.payload) as Record<string, unknown>,
        )
      : null;
    if (!rendered) {
      await finish(row.id, "failed", "nothing to render");
      counts.failed++;
      continue;
    }
    try {
      await mailer.send({ to: row.to_address, idempotencyKey: row.id, ...rendered });
      await finish(row.id, "sent", null);
      counts.sent++;
    } catch (error) {
      if (!(error instanceof EmailSendError)) throw error;
      const attempts = row.attempts + 1;
      if (!error.retryable || attempts >= MAX_EMAIL_ATTEMPTS) {
        await finish(row.id, "failed", error.message);
        counts.failed++;
        logger.error("email.failed", { outboxId: row.id, template: row.template });
      } else {
        // Back off 2, 4, 8, 16… minutes, at most an hour.
        await db
          .prepare(
            `UPDATE notifications_outbox SET attempts = ?, last_error = ?, send_after = ?
             WHERE id = ? AND status = 'pending'`,
          )
          .bind(
            attempts,
            error.message,
            addMinutes(now, Math.min(60, 2 ** attempts)).toISOString(),
            row.id,
          )
          .run();
      }
    }
  }
  return counts;
}

/** 03:00 MYT hour: delete what no longer needs keeping (personal data minimisation). */
export async function cleanUp(context: JobContext): Promise<void> {
  const { services, now } = context;
  if (mytTimeOfDay(now).slice(0, 2) !== "03") return;
  const cutoff = addDays(mytDateString(now), -RECORD_RETENTION_DAYS);
  const cutoffAt = mytDateTime(cutoff).toISOString();
  await services.db.batch([
    services.db.prepare("DELETE FROM rate_limits WHERE expires_at <= ?").bind(now.toISOString()),
    services.db
      .prepare("DELETE FROM notifications_outbox WHERE status <> 'pending' AND created_at < ?")
      .bind(cutoffAt),
    services.db.prepare("DELETE FROM webhook_events WHERE received_at < ?").bind(cutoffAt),
  ]);
}

/**
 * Handover photos are evidence for the deposit. Once a booking has closed (completed,
 * refunded or cancelled — a dispute keeps them) and `retention.photoDays` have passed,
 * the objects are deleted from R2 and the rows marked deleted.
 */
export async function expirePhotos(context: JobContext): Promise<number> {
  const { services, settings, now } = context;
  const bucket = services.photos;
  if (!bucket) return 0;
  const cutoff = addDays(mytDateString(now), -settings.retention.photoDays);
  const { results } = await services.db
    .prepare(
      `SELECT p.id, p.r2_key FROM handover_photos p JOIN bookings b ON b.id = p.booking_id
       WHERE p.deleted_at IS NULL AND b.status IN ('completed', 'refunded', 'cancelled')
         AND b.updated_at < ? LIMIT ?`,
    )
    .bind(mytDateTime(cutoff).toISOString(), BATCH)
    .all<{ id: string; r2_key: string }>();
  if (results.length === 0) return 0;
  await bucket.delete(results.map((row) => row.r2_key));
  await services.db.batch(
    results.map((row) =>
      services.db
        .prepare("UPDATE handover_photos SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL")
        .bind(now.toISOString(), row.id),
    ),
  );
  return results.length;
}

const JOBS = [
  ["holds", expireHolds],
  ["overdue", markOverdue],
  ["daily", queueDailyMessages],
  ["outbox", sendOutbox],
  ["cleanup", cleanUp],
  ["photos", expirePhotos],
] as const;

export async function runScheduled(
  config: AppConfig,
  services: Services,
  logger: Logger,
): Promise<Record<string, unknown>> {
  const context: JobContext = {
    config,
    services,
    logger,
    settings: await services.settings(),
    now: services.now(),
  };
  const summary: Record<string, unknown> = {};
  for (const [name, job] of JOBS) {
    try {
      summary[name] = await job(context);
    } catch (error) {
      summary[name] = "error";
      logger.error("cron.job_failed", { job: name, error });
    }
  }
  logger.info("cron.run", summary);
  return summary;
}
