import type { BookingStatus } from "@lensarent/shared";
import {
  BOOKING_STATUSES,
  addDays,
  allowedTransitions,
  cancellationOutcome,
  dateStringSchema,
  lateFeeSen,
  mytDateTime,
  planBooking,
  quoteRequestSchema,
} from "@lensarent/shared";
import { z } from "zod";
import type { AdminIdentity } from "../lib/access";
import { releaseBookingLocksStatement } from "../lib/availabilityLocks";
import type { Actor, BookingRow, Guard, PreparedTransition } from "../lib/bookings";
import {
  InvalidTransitionError,
  StaleBookingError,
  depositBalance,
  getBooking,
  ledgerStatement,
  lockedDatesOf,
  prepareTransition,
  runTransition,
} from "../lib/bookings";
import { PaymentProviderError } from "../lib/chip";
import { isUniqueViolation, newId } from "../lib/db";
import { cancelHold } from "../lib/holds";
import { errorResponse, jsonResponse, readJson, validationErrorResponse } from "../lib/http";
import type { Handler, RequestContext } from "../router";
import { requireAdmin } from "./adminAuth";
import { BOOKING_FIELD_MESSAGES } from "./bookings";
import { fieldErrors } from "./validation";

/**
 * Admin operations on bookings (master prompt §8). Every change:
 * - names the status the admin saw (`from`), so a stale screen cannot act on a booking
 *   that moved on;
 * - goes through `prepareTransition` (state machine + guarded batch + event + audit);
 * - writes money only as signed, append-only ledger entries in the same batch.
 */
const BOOKING_ID = /^[A-Za-z0-9]{20}$/;
const PAGE_MAX = 100;

export function adminActor(admin: AdminIdentity): Actor {
  return { type: "admin", id: admin.id, email: admin.email };
}

type Loaded = { booking: BookingRow; actor: Actor } | { response: Response };

/** Admin check, then the booking, which must still be in `from` when one is given. */
async function loadForAdmin(context: RequestContext, mutating: boolean): Promise<Loaded> {
  const auth = await requireAdmin(context, { mutating });
  if ("response" in auth) return auth;
  const id = context.params.id ?? "";
  const booking = BOOKING_ID.test(id) ? await getBooking(context.services.db, id) : null;
  if (!booking) return { response: errorResponse("NOT_FOUND") };
  return { booking, actor: adminActor(auth.admin) };
}

type Parsed<T> = { ok: true; value: T } | { ok: false; response: Response };

async function parseBody<T extends z.ZodType>(
  context: RequestContext,
  schema: T,
  messages: Readonly<Record<string, string>> = {},
): Promise<Parsed<z.infer<T>>> {
  const body = await readJson(context.request);
  if (!body.ok) return body;
  const parsed = schema.safeParse(body.value);
  if (!parsed.success) {
    return { ok: false, response: validationErrorResponse(fieldErrors(parsed.error, messages)) };
  }
  return { ok: true, value: parsed.data };
}

/** Runs a transition and maps the two expected failures to 409s. */
async function apply(
  context: RequestContext,
  build: () => PreparedTransition,
  ok: () => Promise<Response> | Response,
): Promise<Response> {
  try {
    await runTransition(context.services.db, build());
  } catch (error) {
    if (error instanceof InvalidTransitionError) return errorResponse("INVALID_TRANSITION");
    if (error instanceof StaleBookingError) return errorResponse("BOOKING_CHANGED");
    throw error;
  }
  return ok();
}

const fromSchema = z.enum(BOOKING_STATUSES);
const noteSchema = z.string().trim().max(500).default("");
const idLast4Schema = z.string().regex(/^\d{4}$/);
const senAmount = z.int().min(0).max(10_000_000);

// ── List and detail ─────────────────────────────────────────────────────────────────────

const listSchema = z.object({
  status: z.enum(BOOKING_STATUSES).optional(),
  /** MYT day: bookings picked up or returned that day. */
  day: dateStringSchema.optional(),
  before: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z~[A-Za-z0-9]{20}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_MAX).default(50),
});

/** GET /api/admin/bookings?status=&day=&before=&limit= — newest first. */
export const listBookingsHandler: Handler = async (context) => {
  const auth = await requireAdmin(context, { mutating: false });
  if ("response" in auth) return auth.response;
  const params = Object.fromEntries(
    [...context.url.searchParams].filter(([, value]) => value !== ""),
  );
  const parsed = listSchema.safeParse(params);
  if (!parsed.success) return validationErrorResponse({ _form: "Penapis tidak sah." });
  const { status, day, before, limit } = parsed.data;

  const where: string[] = [];
  const binds: (string | number)[] = [];
  if (status) {
    where.push("status = ?");
    binds.push(status);
  }
  if (day) {
    const start = mytDateTime(day).toISOString();
    const end = mytDateTime(addDays(day, 1)).toISOString();
    where.push("((pickup_at >= ? AND pickup_at < ?) OR (return_at >= ? AND return_at < ?))");
    binds.push(start, end, start, end);
  }
  if (before) {
    const [createdAt = "", id = ""] = before.split("~");
    where.push("(created_at, id) < (?, ?)");
    binds.push(createdAt, id);
  }
  const { results } = await context.services.db
    .prepare(
      `SELECT id, ref_code, status, status_reason, unit_id, customer_name, customer_phone_e164,
         pickup_at, pickup_location_id, return_at, return_location_id, rental_days,
         total_payable_sen, deposit_sen, created_at
       FROM bookings ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .bind(...binds, limit + 1)
    .all<Record<string, unknown> & { id: string; created_at: string }>();
  const page = results.slice(0, limit);
  const last = page.at(-1);
  return jsonResponse({
    bookings: page,
    next: results.length > limit && last ? `${last.created_at}~${last.id}` : null,
  });
};

/** GET /api/admin/bookings/:id — everything about one booking, plus what can be done next. */
export const bookingDetailHandler: Handler = async (context) => {
  const loaded = await loadForAdmin(context, false);
  if ("response" in loaded) return loaded.response;
  const { booking } = loaded;
  const db = context.services.db;
  const [events, payments, ledger, photos, balance, settings] = await Promise.all([
    db
      .prepare(
        "SELECT from_status, to_status, actor_type, actor_id, reason, at FROM booking_events WHERE booking_id = ? ORDER BY at, rowid",
      )
      .bind(booking.id)
      .all(),
    db
      .prepare(
        "SELECT provider_ref, expected_sen, paid_sen, fee_sen, status, raw_status, is_test, paid_at, created_at FROM payments WHERE booking_id = ? ORDER BY created_at",
      )
      .bind(booking.id)
      .all<{ fee_sen: number | null; status: string }>(),
    db
      .prepare(
        "SELECT id, type, amount_sen, method, reference, note, reverses_id, created_by, created_at FROM ledger_entries WHERE booking_id = ? ORDER BY created_at, rowid",
      )
      .bind(booking.id)
      .all(),
    db
      .prepare(
        "SELECT id, stage, content_type, size_bytes, uploaded_by, created_at FROM handover_photos WHERE booking_id = ? AND deleted_at IS NULL ORDER BY created_at",
      )
      .bind(booking.id)
      .all(),
    depositBalance(db, booking.id),
    context.services.settings(),
  ]);

  const now = context.services.now();
  const paidFee = payments.results.find((payment) => payment.status === "paid")?.fee_sen ?? 0;
  const cancellable = booking.status === "confirmed" || booking.status === "ready_for_pickup";
  // The lookup token's hash is useless to the admin; keep it out of responses.
  const visible: Partial<BookingRow> = { ...booking };
  delete visible.lookup_token_hash;
  return jsonResponse({
    booking: visible,
    events: events.results,
    payments: payments.results,
    ledger: ledger.results,
    photos: photos.results,
    depositBalanceSen: balance,
    allowedTransitions: allowedTransitions(booking.status, "admin"),
    lateFeeSuggestionSen: booking.returned_at
      ? lateFeeSen(
          new Date(booking.return_slot_end),
          new Date(booking.returned_at),
          settings.lateFee,
        )
      : null,
    cancellationPreview: cancellable
      ? cancellationOutcome(
          {
            pickupAt: new Date(booking.pickup_at),
            cancelledAt: now,
            initiator: "customer",
            totalPaidSen: booking.total_payable_sen,
            gatewayFeeSen: paidFee,
            rescheduleUsed: booking.reschedule_used === 1,
          },
          settings.cancellation,
        )
      : null,
  });
};

// ── Simple transitions ──────────────────────────────────────────────────────────────────

/** Transitions that need no data beyond a reason. The rest have their own endpoints. */
const SIMPLE_TARGETS = ["ready_for_pickup", "disputed"] as const satisfies readonly BookingStatus[];

const transitionSchema = z.strictObject({
  from: fromSchema,
  to: z.enum(SIMPLE_TARGETS),
  reason: noteSchema,
});

/** POST /api/admin/bookings/:id/transition {from, to, reason} */
export const transitionHandler: Handler = async (context) => {
  const loaded = await loadForAdmin(context, true);
  if ("response" in loaded) return loaded.response;
  const body = await parseBody(context, transitionSchema);
  if (!body.ok) return body.response;
  const { booking, actor } = loaded;
  if (booking.status !== body.value.from) return errorResponse("BOOKING_CHANGED");
  const now = context.services.now();
  return apply(
    context,
    () =>
      prepareTransition(context.services.db, booking, {
        to: body.value.to,
        actor,
        reason: body.value.reason || undefined,
        now,
      }),
    () => jsonResponse({ ok: true, status: body.value.to }),
  );
};

// ── Cancel and refund ───────────────────────────────────────────────────────────────────

const cancelSchema = z.strictObject({
  from: fromSchema,
  initiator: z.enum(["customer", "business", "no_show"]),
  reason: noteSchema,
});

/**
 * POST /api/admin/bookings/:id/cancel {from, initiator, reason}
 * - unpaid hold → cancelled (the CHIP purchase is made unpayable first);
 * - paid booking → refund_pending: the days are freed and the policy's refund is recorded
 *   as `refund_due_sen`. The money itself is sent by hand, then recorded with /refund.
 */
export const cancelHandler: Handler = async (context) => {
  const loaded = await loadForAdmin(context, true);
  if ("response" in loaded) return loaded.response;
  const body = await parseBody(context, cancelSchema);
  if (!body.ok) return body.response;
  const { booking, actor } = loaded;
  const { from, initiator, reason } = body.value;
  if (booking.status !== from) return errorResponse("BOOKING_CHANGED");
  const { db, payments } = context.services;
  const now = context.services.now();

  if (booking.status === "pending_payment") {
    const payment = await db
      .prepare(
        "SELECT provider_ref FROM payments WHERE booking_id = ? AND status = 'created' LIMIT 1",
      )
      .bind(booking.id)
      .first<{ provider_ref: string }>();
    if (payment) {
      try {
        if (!payments || !(await payments.cancel(payment.provider_ref))) {
          // CHIP would not cancel it: it may have just been paid. Let the webhook decide.
          return errorResponse("BOOKING_CHANGED");
        }
      } catch (error) {
        if (error instanceof PaymentProviderError) return errorResponse("PAYMENT_UNAVAILABLE");
        throw error;
      }
    }
    try {
      await cancelHold(db, booking, `admin:${reason || initiator}`, actor, now);
    } catch (error) {
      if (error instanceof StaleBookingError) return errorResponse("BOOKING_CHANGED");
      throw error;
    }
    return jsonResponse({ ok: true, status: "cancelled" });
  }

  const settings = await context.services.settings();
  const paid = await db
    .prepare("SELECT fee_sen FROM payments WHERE booking_id = ? AND status = 'paid' LIMIT 1")
    .bind(booking.id)
    .first<{ fee_sen: number | null }>();
  const outcome = cancellationOutcome(
    {
      pickupAt: new Date(booking.pickup_at),
      cancelledAt: now,
      initiator,
      totalPaidSen: booking.total_payable_sen,
      gatewayFeeSen: paid?.fee_sen ?? 0,
      rescheduleUsed: booking.reschedule_used === 1,
    },
    settings.cancellation,
  );
  return apply(
    context,
    () =>
      prepareTransition(
        db,
        booking,
        {
          to: "refund_pending",
          actor,
          reason: `cancel_${initiator}_${outcome.tier.toLowerCase()}`,
          set: { refund_due_sen: outcome.refundSen },
          now,
        },
        (guard) => [releaseBookingLocksStatement(db, booking.id, guard)],
      ),
    () => jsonResponse({ ok: true, status: "refund_pending", outcome }),
  );
};

const refundSchema = z.strictObject({
  from: z.literal("refund_pending"),
  amountSen: senAmount,
  method: z.enum(["gateway", "duitnow", "cash"]),
  reference: z.string().trim().min(1).max(100),
  note: noteSchema,
});

/**
 * POST /api/admin/bookings/:id/refund — records a refund the admin has SENT, and closes
 * the booking. For a paid booking the deposit comes back first (DEPOSIT_REFUND), the rest
 * is REFUND; if less than the deposit is returned, the remainder is kept as a deduction.
 * Money that was never booked as income (a mismatched payment) gets no ledger entries.
 */
export const refundHandler: Handler = async (context) => {
  const loaded = await loadForAdmin(context, true);
  if ("response" in loaded) return loaded.response;
  const body = await parseBody(context, refundSchema, {
    amountSen: "Jumlah bayaran balik tidak sah.",
    reference: "Sila masukkan rujukan pemindahan.",
  });
  if (!body.ok) return body.response;
  const { booking, actor } = loaded;
  const { amountSen, method, reference, note } = body.value;
  if (booking.status !== "refund_pending") return errorResponse("BOOKING_CHANGED");

  const db = context.services.db;
  const deposit = await depositBalance(db, booking.id);
  const income = await db
    .prepare("SELECT COUNT(*) AS n FROM ledger_entries WHERE booking_id = ? AND type = 'RENTAL'")
    .bind(booking.id)
    .first<{ n: number }>();
  const booked = (income?.n ?? 0) > 0;
  const ceiling = booked ? booking.total_payable_sen : (booking.refund_due_sen ?? 0);
  if (amountSen > ceiling) {
    return validationErrorResponse({ amountSen: "Jumlah melebihi apa yang dibayar." });
  }
  const now = context.services.now();
  const entry = (guard: Guard, type: Parameters<typeof ledgerStatement>[2]["type"], sen: number) =>
    ledgerStatement(db, guard, {
      bookingId: booking.id,
      type,
      amountSen: sen,
      method: type === "DEPOSIT_DEDUCTION" || type === "CANCELLATION_FEE" ? "deposit" : method,
      reference,
      note,
      createdBy: actor.id,
      at: now,
    });

  return apply(
    context,
    () =>
      prepareTransition(
        db,
        booking,
        { to: "refunded", actor, reason: `refund_${method}`, now },
        (guard) => {
          if (!booked) return [];
          const depositBack = Math.min(deposit, amountSen);
          const kept = deposit - depositBack;
          const rest = amountSen - depositBack;
          return [
            ...(depositBack > 0 ? [entry(guard, "DEPOSIT_REFUND", -depositBack)] : []),
            ...(kept > 0
              ? [entry(guard, "DEPOSIT_DEDUCTION", -kept), entry(guard, "CANCELLATION_FEE", kept)]
              : []),
            ...(rest > 0 ? [entry(guard, "REFUND", -rest)] : []),
          ];
        },
      ),
    () => jsonResponse({ ok: true, status: "refunded" }),
  );
};

// ── Handover, return, settlement ────────────────────────────────────────────────────────

async function photoCount(db: D1Database, bookingId: string, stage: string): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM handover_photos WHERE booking_id = ? AND stage = ? AND deleted_at IS NULL",
    )
    .bind(bookingId, stage)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

const checklistSchema = z
  .record(z.string().regex(/^[a-z_]{1,40}$/), z.boolean())
  .refine((value) => Object.keys(value).length <= 30);
const accessoriesSchema = z.array(z.string().trim().min(1).max(60)).max(30);

const handoverSchema = z.strictObject({
  from: z.literal("ready_for_pickup"),
  /** Last four digits of the MyKad, checked in person. Never the full number. */
  idLast4: idLast4Schema,
  checklist: checklistSchema,
  accessories: accessoriesSchema,
  note: noteSchema,
});

/** POST /api/admin/bookings/:id/handover — the camera goes out. Needs ≥1 checkout photo. */
export const handoverHandler: Handler = async (context) => {
  const loaded = await loadForAdmin(context, true);
  if ("response" in loaded) return loaded.response;
  const body = await parseBody(context, handoverSchema, {
    idLast4: "Masukkan 4 digit terakhir MyKad sahaja.",
  });
  if (!body.ok) return body.response;
  const { booking, actor } = loaded;
  if (booking.status !== "ready_for_pickup") return errorResponse("BOOKING_CHANGED");
  const db = context.services.db;
  if ((await photoCount(db, booking.id, "checkout")) === 0) return errorResponse("PHOTO_REQUIRED");
  const now = context.services.now();
  const { idLast4, checklist, accessories, note } = body.value;

  return apply(
    context,
    () =>
      prepareTransition(
        db,
        booking,
        {
          to: "active_rental",
          actor,
          reason: "handover",
          set: {
            id_last4: idLast4,
            verified_by: actor.email ?? actor.id,
            verified_at: now.toISOString(),
            handover: JSON.stringify({ checklist, accessories, note, at: now.toISOString() }),
          },
          now,
        },
        (guard) => [
          // An identity check in person makes a new customer a verified one.
          db
            .prepare(
              `UPDATE customers SET tier = 'verified', updated_at = ?
               WHERE id = ? AND tier = 'new' AND ${guard.sql}`,
            )
            .bind(now.toISOString(), booking.customer_id, ...guard.params),
        ],
      ),
    () => jsonResponse({ ok: true, status: "active_rental" }),
  );
};

const returnSchema = z.strictObject({
  from: z.enum(["active_rental", "overdue"]),
  /** When the camera actually came back; defaults to now. */
  returnedAt: z.iso.datetime().optional(),
  checklist: checklistSchema,
  accessories: accessoriesSchema,
  note: noteSchema,
});

/** POST /api/admin/bookings/:id/return — the camera is back. Needs ≥1 return photo. */
export const returnHandler: Handler = async (context) => {
  const loaded = await loadForAdmin(context, true);
  if ("response" in loaded) return loaded.response;
  const body = await parseBody(context, returnSchema);
  if (!body.ok) return body.response;
  const { booking, actor } = loaded;
  if (booking.status !== body.value.from) return errorResponse("BOOKING_CHANGED");
  const db = context.services.db;
  if ((await photoCount(db, booking.id, "return")) === 0) return errorResponse("PHOTO_REQUIRED");

  const now = context.services.now();
  const returnedAt = body.value.returnedAt ? new Date(body.value.returnedAt) : now;
  if (returnedAt > now || returnedAt < new Date(booking.pickup_at)) {
    return validationErrorResponse({ returnedAt: "Masa pulang tidak munasabah." });
  }
  const settings = await context.services.settings();
  const suggestion = lateFeeSen(new Date(booking.return_slot_end), returnedAt, settings.lateFee);
  const { checklist, accessories, note } = body.value;
  return apply(
    context,
    () =>
      prepareTransition(db, booking, {
        to: "return_inspection",
        actor,
        reason: "returned",
        set: {
          returned_at: returnedAt.toISOString(),
          return_inspection: JSON.stringify({
            checklist,
            accessories,
            note,
            at: now.toISOString(),
          }),
        },
        now,
      }),
    () => jsonResponse({ ok: true, status: "return_inspection", lateFeeSuggestionSen: suggestion }),
  );
};

const settleSchema = z.strictObject({
  from: z.enum(["return_inspection", "disputed"]),
  /** Approved by the admin; the system only suggests it. */
  lateFeeSen: senAmount,
  damageSen: senAmount,
  refundMethod: z.enum(["duitnow", "cash", "gateway"]),
  refundReference: z.string().trim().max(100).default(""),
  note: noteSchema,
});

/**
 * POST /api/admin/bookings/:id/settle — closes the deposit and completes the booking.
 * Deductions (late fee, damage) come out of the deposit; the rest is refunded. The deposit
 * balance is zero afterwards by construction, which `completed` requires.
 */
export const settleHandler: Handler = async (context) => {
  const loaded = await loadForAdmin(context, true);
  if ("response" in loaded) return loaded.response;
  const body = await parseBody(context, settleSchema, {
    refundReference: "Rujukan terlalu panjang.",
  });
  if (!body.ok) return body.response;
  const { booking, actor } = loaded;
  const {
    from,
    lateFeeSen: late,
    damageSen: damage,
    refundMethod,
    refundReference,
    note,
  } = body.value;
  if (booking.status !== from) return errorResponse("BOOKING_CHANGED");
  const db = context.services.db;
  const deposit = await depositBalance(db, booking.id);
  if (late + damage > deposit) {
    return validationErrorResponse({
      damageSen:
        "Potongan melebihi baki deposit. Kutip bakinya secara berasingan dan rekodkan dalam lejar dahulu.",
    });
  }
  const refund = deposit - late - damage;
  if (refund > 0 && refundReference === "" && refundMethod !== "cash") {
    return validationErrorResponse({
      refundReference: "Sila masukkan rujukan pemindahan deposit.",
    });
  }
  const now = context.services.now();
  const entry = (
    guard: Guard,
    type: "DEPOSIT_DEDUCTION" | "LATE_FEE" | "DAMAGE_CHARGE" | "DEPOSIT_REFUND",
    sen: number,
    method: "deposit" | "duitnow" | "cash" | "gateway",
  ) =>
    ledgerStatement(db, guard, {
      bookingId: booking.id,
      type,
      amountSen: sen,
      method,
      reference: type === "DEPOSIT_REFUND" ? refundReference : "",
      note,
      createdBy: actor.id,
      at: now,
    });

  return apply(
    context,
    () =>
      prepareTransition(
        db,
        booking,
        { to: "completed", actor, reason: "settled", now },
        (guard) => [
          ...(late > 0
            ? [
                entry(guard, "DEPOSIT_DEDUCTION", -late, "deposit"),
                entry(guard, "LATE_FEE", late, "deposit"),
              ]
            : []),
          ...(damage > 0
            ? [
                entry(guard, "DEPOSIT_DEDUCTION", -damage, "deposit"),
                entry(guard, "DAMAGE_CHARGE", damage, "deposit"),
              ]
            : []),
          ...(refund > 0 ? [entry(guard, "DEPOSIT_REFUND", -refund, refundMethod)] : []),
          db
            .prepare(
              `UPDATE customers SET completed_count = completed_count + 1,
                 tier = 'returning', updated_at = ? WHERE id = ? AND ${guard.sql}`,
            )
            .bind(now.toISOString(), booking.customer_id, ...guard.params),
        ],
      ),
    () => jsonResponse({ ok: true, status: "completed", depositRefundSen: refund }),
  );
};

// ── Manual ledger entries and reversals ────────────────────────────────────────────────

const ledgerSchema = z.strictObject({
  type: z.enum([
    "LATE_FEE",
    "DAMAGE_CHARGE",
    "REFUND",
    "GATEWAY_FEE",
    "DEPOSIT_REFUND",
    "DEPOSIT_DEDUCTION",
  ]),
  amountSen: z.int().min(-10_000_000).max(10_000_000),
  method: z.enum(["gateway", "duitnow", "cash", "deposit"]),
  reference: z.string().trim().max(100).default(""),
  note: z.string().trim().min(3).max(500),
});
const reversalSchema = z.strictObject({
  reversesId: z.string().regex(/^[A-Za-z0-9]{20}$/),
  note: z.string().trim().min(3).max(500),
});

/**
 * POST /api/admin/bookings/:id/ledger — an extra charge or refund collected outside the
 * normal flow, or `{reversesId, note}` to reverse an entry (the only way to correct one).
 */
export const ledgerEntryHandler: Handler = async (context) => {
  const loaded = await loadForAdmin(context, true);
  if ("response" in loaded) return loaded.response;
  const body = await readJson(context.request);
  if (!body.ok) return body.response;
  const { booking, actor } = loaded;
  const db = context.services.db;
  const now = context.services.now();
  const audit = (entryId: string, action: string) =>
    db
      .prepare(
        `INSERT INTO audit_logs (id, actor_id, actor_email, action, target_table, target_id, changed_fields, at)
         SELECT ?, ?, ?, ?, 'ledger_entries', ?, '[]', ? WHERE EXISTS (SELECT 1 FROM ledger_entries WHERE id = ?)`,
      )
      .bind(newId(), actor.id, actor.email ?? "", action, entryId, now.toISOString(), entryId);

  const reversal = reversalSchema.safeParse(body.value);
  if (reversal.success) {
    const original = await db
      .prepare(
        "SELECT id, type, amount_sen, method, reverses_id FROM ledger_entries WHERE id = ? AND booking_id = ?",
      )
      .bind(reversal.data.reversesId, booking.id)
      .first<{
        id: string;
        type: string;
        amount_sen: number;
        method: string;
        reverses_id: string | null;
      }>();
    if (!original || original.reverses_id !== null) return errorResponse("NOT_FOUND");
    const id = newId();
    try {
      await db.batch([
        db
          .prepare(
            `INSERT INTO ledger_entries (id, booking_id, type, amount_sen, method, reference, note, reverses_id, created_by, created_at)
             VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?)`,
          )
          .bind(
            id,
            booking.id,
            original.type,
            -original.amount_sen,
            original.method,
            reversal.data.note,
            original.id,
            actor.id,
            now.toISOString(),
          ),
        audit(id, "ledger.reverse"),
      ]);
    } catch (error) {
      // reverses_id is UNIQUE: an entry can be reversed once.
      if (isUniqueViolation(error)) return errorResponse("BOOKING_CHANGED");
      throw error;
    }
    return jsonResponse({ ok: true, id }, 201);
  }

  const parsed = ledgerSchema.safeParse(body.value);
  if (!parsed.success) {
    return validationErrorResponse(
      fieldErrors(parsed.error, { amountSen: "Jumlah tidak sah.", note: "Sila nyatakan sebab." }),
    );
  }
  const id = newId();
  let statement: D1PreparedStatement;
  try {
    statement = ledgerStatement(db, null, {
      id,
      bookingId: booking.id,
      ...parsed.data,
      createdBy: actor.id,
      at: now,
    });
  } catch {
    return validationErrorResponse({
      amountSen: "Tanda (+/−) jumlah tidak sepadan dengan jenis entri.",
    });
  }
  await db.batch([statement, audit(id, `ledger.${parsed.data.type.toLowerCase()}`)]);
  return jsonResponse({ ok: true, id }, 201);
};

// ── Reschedule (once, same length and price) ───────────────────────────────────────────

const rescheduleSchema = z.strictObject({
  from: z.enum(["confirmed", "ready_for_pickup"]),
  period: quoteRequestSchema,
});

/**
 * POST /api/admin/bookings/:id/reschedule — the policy's one free date change. The new
 * period must cost exactly the same; otherwise cancel and book again. Old days are freed
 * and new days locked on the same unit in ONE batch.
 */
export const rescheduleHandler: Handler = async (context) => {
  const loaded = await loadForAdmin(context, true);
  if ("response" in loaded) return loaded.response;
  const body = await parseBody(context, rescheduleSchema, BOOKING_FIELD_MESSAGES);
  if (!body.ok) return body.response;
  const { booking, actor } = loaded;
  if (booking.status !== body.value.from) return errorResponse("BOOKING_CHANGED");
  if (booking.reschedule_used === 1) {
    return validationErrorResponse({ _form: "Tempahan ini sudah pernah ditukar tarikh." });
  }
  const db = context.services.db;
  const now = context.services.now();
  const settings = await context.services.settings();
  const customer = await db
    .prepare("SELECT tier FROM customers WHERE id = ?")
    .bind(booking.customer_id)
    .first<{ tier: "new" | "verified" | "returning" }>();
  const plan = planBooking(body.value.period, settings, customer?.tier ?? "new", now);
  if (!plan.ok) {
    return validationErrorResponse({
      [plan.field]: BOOKING_FIELD_MESSAGES[plan.field] ?? "Tidak sah.",
    });
  }
  const { quote, pickup, lockedDates, rentalDays } = plan.value;
  if (
    quote.breakdown.totalPayableSen - quote.breakdown.depositSen !==
    booking.total_payable_sen - booking.deposit_sen
  ) {
    return validationErrorResponse({
      _form: "Harga tempoh baharu berbeza. Batalkan dan buat tempahan baharu.",
    });
  }

  const transitionId = newId();
  const at = now.toISOString();
  const guard = "EXISTS (SELECT 1 FROM bookings WHERE id = ? AND last_transition_id = ?)";
  const p = body.value.period;
  const statements = [
    db
      .prepare(
        `UPDATE bookings SET pickup_slot_id = ?, pickup_at = ?, pickup_location_id = ?,
           return_slot_id = ?, return_at = ?, return_slot_end = ?, return_location_id = ?,
           locked_dates = ?, rental_days = ?, reschedule_used = 1, last_transition_id = ?, updated_at = ?
         WHERE id = ? AND status = ? AND reschedule_used = 0`,
      )
      .bind(
        p.pickupSlotId,
        pickup.start.toISOString(),
        p.pickupLocationId,
        p.returnSlotId,
        plan.value.return.start.toISOString(),
        plan.value.return.end.toISOString(),
        p.returnLocationId,
        JSON.stringify(lockedDates),
        rentalDays,
        transitionId,
        at,
        booking.id,
        booking.status,
      ),
    db
      .prepare(`DELETE FROM availability_locks WHERE booking_id = ? AND ${guard}`)
      .bind(booking.id, booking.id, transitionId),
    // Plain inserts: if any new day is taken the whole batch, the UPDATE included, rolls back.
    ...lockedDates.map((date) =>
      db
        .prepare(
          `INSERT INTO availability_locks (unit_id, date, kind, booking_id, block_id, hold_expires_at, created_at)
           VALUES (?, ?, 'booking', ?, NULL, NULL, ?)`,
        )
        .bind(booking.unit_id, date, booking.id, at),
    ),
    db
      .prepare(
        `INSERT INTO audit_logs (id, actor_id, actor_email, action, target_table, target_id, changed_fields, at)
         SELECT ?, ?, ?, 'booking.reschedule', 'bookings', ?, ?, ? WHERE ${guard}`,
      )
      .bind(
        newId(),
        actor.id,
        actor.email ?? "",
        booking.id,
        JSON.stringify(["pickup_at", "return_at", "locked_dates", "reschedule_used"]),
        at,
        booking.id,
        transitionId,
      ),
  ];
  try {
    const [update] = await db.batch(statements);
    if (update?.meta.changes !== 1) return errorResponse("BOOKING_CHANGED");
  } catch (error) {
    if (isUniqueViolation(error)) return errorResponse("SLOT_UNAVAILABLE");
    throw error;
  }
  return jsonResponse({ ok: true, lockedDates, previousDates: lockedDatesOf(booking) });
};
