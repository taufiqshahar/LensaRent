import { newId } from "./db";

/**
 * Notifications are never sent inside a request or a booking batch: they are queued in
 * `notifications_outbox` in the same batch as the change that causes them, and the cron
 * sends them (with retries). A message is queued at most once per `dedupeKey`.
 */
export const EMAIL_TEMPLATES = [
  "booking_confirmed",
  "admin_new_booking",
  "admin_payment_problem",
] as const;
export type EmailTemplate = (typeof EMAIL_TEMPLATES)[number];

export interface OutboxMessage {
  template: EmailTemplate;
  to: string;
  /** Ids only (e.g. `bookingId`); the sender loads the rest when it sends. */
  payload: Readonly<Record<string, string>>;
  dedupeKey: string;
  sendAfter: Date;
  createdAt: Date;
}

/** Queues an email, only if `guard` (from `prepareTransition`) holds. */
export function outboxStatement(
  db: D1Database,
  guard: { sql: string; params: readonly string[] } | null,
  message: OutboxMessage,
): D1PreparedStatement {
  const values = [
    newId(),
    message.template,
    message.to,
    JSON.stringify(message.payload),
    message.sendAfter.toISOString(),
    message.dedupeKey,
    message.createdAt.toISOString(),
  ];
  const head = `INSERT INTO notifications_outbox
    (id, channel, template, to_address, payload, status, attempts, send_after, dedupe_key, created_at)`;
  return guard
    ? db
        .prepare(
          `${head} SELECT ?, 'email', ?, ?, ?, 'pending', 0, ?, ?, ? WHERE ${guard.sql}
           ON CONFLICT (dedupe_key) DO NOTHING`,
        )
        .bind(...values, ...guard.params)
    : db
        .prepare(
          `${head} VALUES (?, 'email', ?, ?, ?, 'pending', 0, ?, ?, ?)
           ON CONFLICT (dedupe_key) DO NOTHING`,
        )
        .bind(...values);
}
