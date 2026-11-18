import { addDays, addMinutes, mytDateTime } from "@lensarent/shared";
import { beforeEach, describe, expect, it } from "vitest";
import type { BookingRow } from "../../src/lib/bookings";
import { getBooking, prepareTransition, runTransition } from "../../src/lib/bookings";
import { createLogger } from "../../src/lib/logger";
import type { Email, Mailer } from "../../src/lib/resend";
import { EmailSendError } from "../../src/lib/resend";
import type { JobContext } from "../../src/scheduled";
import {
  HOLD_ALERT_AFTER_MINUTES,
  cleanUp,
  expireHolds,
  markOverdue,
  queueDailyMessages,
  runScheduled,
  sendOutbox,
} from "../../src/scheduled";
import { createServices } from "../../src/services";
import { TEST_ENV, testConfig, testDb } from "../helpers";
import type { BookingWorld } from "../support/booking";
import { TEST_SETTINGS, bookingWorld, holdBody, period, randomToday } from "../support/booking";
import type { FakeChip } from "../support/fakeChip";
import { createFakeChip } from "../support/fakeChip";
import { call, jsonInit, randomIp } from "./app";

/*
 * These tests live in years 2030–2099, before every other file's calendar (2100+), so the
 * cron's global queries ("every expired hold", "every due email") only ever see rows made
 * here. Assertions are about this test's own rows, never about global counts.
 */
const db = testDb();
const logger = createLogger({ environment: "test", sink: () => undefined });
const ADMIN = "admin@lensarent.test";

let chip: FakeChip;
let world: BookingWorld;
let sent: Email[];
let mailerError: EmailSendError | null;

const mailer: Mailer = {
  send(email) {
    if (mailerError) return Promise.reject(mailerError);
    sent.push(email);
    return Promise.resolve();
  },
};

beforeEach(async () => {
  chip = await createFakeChip();
  world = bookingWorld(chip, {}, randomToday(2030, 70));
  sent = [];
  mailerError = null;
});

function context(overrides: Partial<JobContext> = {}): JobContext {
  const config = testConfig({ siteOrigin: "https://lensarent.test" });
  return {
    config,
    services: {
      ...createServices(config, TEST_ENV),
      payments: world.provider,
      mailer,
      settings: () => Promise.resolve(TEST_SETTINGS),
      now: () => world.clock.now,
    },
    settings: TEST_SETTINGS,
    logger,
    now: world.clock.now,
    ...overrides,
  };
}

async function hold(overrides: Record<string, unknown> = {}) {
  const response = await call(
    world.app,
    "/api/bookings/hold",
    jsonInit("POST", holdBody(world.today, overrides), { "cf-connecting-ip": randomIp() }),
  );
  expect(response.status).toBe(201);
  const body: { refCode: string; lookupToken: string; holdExpiresAt: string } =
    await response.json();
  const row = await db
    .prepare("SELECT id FROM bookings WHERE ref_code = ?")
    .bind(body.refCode)
    .first<{ id: string }>();
  if (!row) throw new Error("missing booking");
  return { ...body, id: row.id, purchase: chip.byReference(body.refCode) };
}

async function confirmed(overrides: Record<string, unknown> = {}) {
  const held = await hold(overrides);
  chip.pay(held.purchase.id);
  const response = await world.app.fetch(await chip.callback(held.purchase.id), TEST_ENV);
  expect(await response.json()).toMatchObject({ result: "confirmed" });
  return held;
}

async function booking(id: string): Promise<BookingRow> {
  const row = await getBooking(db, id);
  if (!row) throw new Error("missing booking");
  return row;
}

async function lockCount(id: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM availability_locks WHERE booking_id = ?")
    .bind(id)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function outbox(dedupeKey: string) {
  return db
    .prepare(
      "SELECT id, status, attempts, send_after, last_error FROM notifications_outbox WHERE dedupe_key = ?",
    )
    .bind(dedupeKey)
    .first<{
      id: string;
      status: string;
      attempts: number;
      send_after: string;
      last_error: string | null;
    }>();
}

function afterHold(holdExpiresAt: string, minutes = 3) {
  world.clock.now = addMinutes(new Date(holdExpiresAt), minutes);
}

describe("expired holds", () => {
  it("cancel the CHIP purchase first, then free the days", async () => {
    const held = await hold();
    afterHold(held.holdExpiresAt);
    await expireHolds(context());
    expect(chip.purchases.get(held.purchase.id)?.status).toBe("cancelled");
    expect(await booking(held.id)).toMatchObject({
      status: "cancelled",
      status_reason: "hold_expired",
    });
    expect(await lockCount(held.id)).toBe(0);
    const payment = await db
      .prepare("SELECT status FROM payments WHERE booking_id = ?")
      .bind(held.id)
      .first();
    expect(payment).toEqual({ status: "cancelled" });
  });

  it("confirm a hold that was paid but whose callback never arrived", async () => {
    const held = await hold();
    chip.pay(held.purchase.id);
    afterHold(held.holdExpiresAt);
    await expireHolds(context());
    expect(await booking(held.id)).toMatchObject({ status: "confirmed" });
    expect(await lockCount(held.id)).toBe(3);
  });

  it("leave holds alone until the grace period has passed", async () => {
    const held = await hold();
    afterHold(held.holdExpiresAt, 1);
    await expireHolds(context());
    expect((await booking(held.id)).status).toBe("pending_payment");
  });

  it("wait while CHIP is still executing a payment", async () => {
    const held = await hold();
    held.purchase.status = "pending_execute";
    afterHold(held.holdExpiresAt);
    await expireHolds(context());
    expect((await booking(held.id)).status).toBe("pending_payment");
    expect(await lockCount(held.id)).toBe(3);
  });

  it("keep the days while CHIP cannot confirm the purchase is dead, and alert after a while", async () => {
    const held = await hold();
    chip.cancelStatus = 502;
    afterHold(held.holdExpiresAt);
    await expireHolds(context());
    expect((await booking(held.id)).status).toBe("pending_payment");
    expect(await outbox(`admin_hold_unresolved:${held.id}:${ADMIN}`)).toBeNull();

    afterHold(held.holdExpiresAt, HOLD_ALERT_AFTER_MINUTES);
    await expireHolds(context());
    expect(await lockCount(held.id)).toBe(3);
    expect(await outbox(`admin_hold_unresolved:${held.id}:${ADMIN}`)).toMatchObject({
      status: "pending",
    });

    // Once CHIP answers again, the hold is closed normally.
    chip.cancelStatus = null;
    await expireHolds(context());
    expect((await booking(held.id)).status).toBe("cancelled");
  });

  it("cancel a hold that never got a purchase", async () => {
    const held = await hold();
    await db.prepare("DELETE FROM payments WHERE booking_id = ?").bind(held.id).run();
    afterHold(held.holdExpiresAt);
    await expireHolds(context());
    expect((await booking(held.id)).status).toBe("cancelled");
  });

  it("free days that a new customer can then hold", async () => {
    const first = await hold();
    await hold();
    afterHold(first.holdExpiresAt);
    await expireHolds(context());
    // Both expired holds are gone; the same days can be held again.
    world.clock.now = mytDateTime(world.today, "09:00");
    await hold();
    await hold();
  });
});

describe("overdue rentals", () => {
  async function activeRental() {
    const held = await confirmed();
    const actor = { type: "admin" as const, id: "a", email: ADMIN };
    for (const to of ["ready_for_pickup", "active_rental"] as const) {
      await runTransition(
        db,
        prepareTransition(db, await booking(held.id), { to, actor, now: world.clock.now }),
      );
    }
    return held;
  }

  it("become overdue after the return slot and its grace period, with an admin alert", async () => {
    const held = await activeRental();
    const end = new Date((await booking(held.id)).return_slot_end);
    world.clock.now = addMinutes(end, TEST_SETTINGS.lateFee.graceMinutes - 1);
    await markOverdue(context());
    expect((await booking(held.id)).status).toBe("active_rental");

    world.clock.now = addMinutes(end, TEST_SETTINGS.lateFee.graceMinutes);
    await markOverdue(context());
    expect(await booking(held.id)).toMatchObject({
      status: "overdue",
      status_reason: "return_slot_passed",
    });
    expect(await outbox(`admin_overdue:${held.id}:${ADMIN}`)).toMatchObject({ status: "pending" });
  });
});

describe("email outbox", () => {
  it("sends the confirmation with a status link whose token opens the booking", async () => {
    const held = await confirmed({ name: "Siti <script>alert(1)</script>" });
    const result = await sendOutbox(context());
    expect(result.sent).toBeGreaterThanOrEqual(2);

    const email = sent.find((e) => e.subject === `Tempahan disahkan — ${held.refCode}`);
    expect(email?.to).toBe("aisyah@example.com");
    expect(email?.text).toContain("Termasuk deposit keselamatan RM100.00");
    expect(email?.html).not.toContain("<script>");
    expect(email?.html).toContain("&lt;script&gt;");

    const token = /#t=([A-Za-z0-9_-]+)/.exec(email?.text ?? "")?.[1];
    expect(token).toBe(held.lookupToken);
    const lookup = await call(world.app, `/api/bookings/lookup?ref=${held.refCode}`, {
      headers: { "x-booking-token": token ?? "" },
    });
    expect(lookup.status).toBe(200);

    expect(sent.find((e) => e.subject === `Tempahan baharu ${held.refCode}`)?.to).toBe(ADMIN);
    expect(await outbox(`booking_confirmed:${held.id}`)).toMatchObject({
      status: "sent",
      attempts: 1,
    });
  });

  it("retries a temporary failure later and gives up on a permanent one", async () => {
    const held = await confirmed();
    mailerError = new EmailSendError("Resend answered HTTP 503", true);
    await sendOutbox(context());
    const retry = await outbox(`booking_confirmed:${held.id}`);
    expect(retry).toMatchObject({
      status: "pending",
      attempts: 1,
      last_error: "Resend answered HTTP 503",
    });
    expect(retry?.send_after).toBe(addMinutes(world.clock.now, 2).toISOString());

    // Not due yet: nothing is sent.
    mailerError = null;
    await sendOutbox(context());
    expect(
      sent.some(
        (e) => e.subject.includes(held.refCode) && e.subject.startsWith("Tempahan disahkan"),
      ),
    ).toBe(false);

    mailerError = new EmailSendError("Resend answered HTTP 422", false);
    world.clock.now = addMinutes(world.clock.now, 2);
    await sendOutbox(context());
    expect(await outbox(`booking_confirmed:${held.id}`)).toMatchObject({
      status: "failed",
      attempts: 2,
    });
  });

  it("waits, unsent, when no mailer is configured", async () => {
    const held = await confirmed();
    const ctx = context();
    await sendOutbox({ ...ctx, services: { ...ctx.services, mailer: undefined } });
    expect(await outbox(`booking_confirmed:${held.id}`)).toMatchObject({
      status: "pending",
      attempts: 0,
    });
  });
});

describe("daily messages", () => {
  it("queue the morning summary once per day, however often the cron runs", async () => {
    const pickupDay = addDays(world.today, 2);
    await confirmed();
    world.clock.now = mytDateTime(pickupDay, "08:00");
    await queueDailyMessages(context());
    world.clock.now = mytDateTime(pickupDay, "08:37");
    await queueDailyMessages(context());
    const row = await outbox(`admin_daily_summary:${pickupDay}:${ADMIN}`);
    expect(row?.status).toBe("pending");

    await sendOutbox(context());
    const summary = sent.find((e) => e.subject.startsWith("Ringkasan"));
    expect(summary?.subject).toMatch(/1 ambil, 0 pulang/);
  });

  it("queue a reminder at 18:00 for tomorrow's pickups only", async () => {
    const tomorrowPickup = await confirmed();
    const later = await confirmed(period(world.today, 5));
    world.clock.now = mytDateTime(addDays(world.today, 1), "18:00");
    await queueDailyMessages(context());
    expect(await outbox(`pickup_reminder:${tomorrowPickup.id}`)).toMatchObject({
      status: "pending",
    });
    expect(await outbox(`pickup_reminder:${later.id}`)).toBeNull();
  });

  it("do nothing outside their hours", async () => {
    world.clock.now = mytDateTime(world.today, "12:00");
    expect(await queueDailyMessages(context())).toBe(0);
  });
});

describe("cleanup", () => {
  it("deletes sent emails and webhook records older than the retention period at 03:00", async () => {
    const held = await confirmed();
    await sendOutbox(context());
    world.clock.now = mytDateTime(addDays(world.today, 91), "03:10");
    await cleanUp(context());
    expect(await outbox(`booking_confirmed:${held.id}`)).toBeNull();
    const webhook = await db
      .prepare("SELECT COUNT(*) AS n FROM webhook_events WHERE event_key LIKE ?")
      .bind(`${held.purchase.id}:%`)
      .first<{ n: number }>();
    expect(webhook?.n).toBe(0);
  });
});

describe("runScheduled", () => {
  it("runs every job even when one of them fails", async () => {
    const held = await hold();
    afterHold(held.holdExpiresAt);
    const ctx = context();
    const broken = {
      ...ctx.services,
      payments: {
        ...ctx.services.payments,
        fetchPayment: () => Promise.reject(new TypeError("boom")),
      } as unknown as typeof ctx.services.payments,
    };
    const summary = await runScheduled(ctx.config, broken, logger);
    expect(summary).toMatchObject({ holds: "error", overdue: 0 });
    expect(summary).toHaveProperty("outbox");
  });
});
