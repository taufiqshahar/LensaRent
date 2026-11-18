import { addDays, holdRequestSchema, planBooking } from "@lensarent/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { createHold, startPayment, upsertCustomer } from "../../src/lib/holds";
import {
  InvalidTransitionError,
  StaleBookingError,
  getBooking,
  prepareTransition,
  runTransition,
} from "../../src/lib/bookings";
import { createChipProvider } from "../../src/lib/chip";
import { createLogger } from "../../src/lib/logger";
import { TEST_ENV, testDb } from "../helpers";
import type { FakeChip } from "../support/fakeChip";
import { createFakeChip } from "../support/fakeChip";
import type { BookingWorld } from "../support/booking";
import { TEST_SETTINGS, bookingWorld, holdBody, period } from "../support/booking";
import { call, jsonInit, randomIp } from "./app";

const db = testDb();
const logger = createLogger({ environment: "test" });

interface HoldResponse {
  refCode: string;
  lookupToken: string;
  checkoutUrl: string;
  holdExpiresAt: string;
  breakdown: { totalPayableSen: number; depositSen: number };
}

let chip: FakeChip;
let world: BookingWorld;

beforeEach(async () => {
  chip = await createFakeChip();
  world = bookingWorld(chip);
});

function post(path: string, body: unknown, w: BookingWorld = world) {
  return call(w.app, path, jsonInit("POST", body, { "cf-connecting-ip": randomIp() }));
}

async function hold(overrides: Record<string, unknown> = {}, w: BookingWorld = world) {
  return post("/api/bookings/hold", holdBody(w.today, overrides), w);
}

async function heldBooking(overrides: Record<string, unknown> = {}) {
  const response = await hold(overrides);
  expect(response.status).toBe(201);
  const body: HoldResponse = await response.json();
  const row = await db
    .prepare("SELECT * FROM bookings WHERE ref_code = ?")
    .bind(body.refCode)
    .first<
      Record<string, unknown> & {
        id: string;
        status: string;
        customer_id: string;
        customer_phone_e164: string;
        unit_id: string;
        lookup_token_hash: string;
      }
    >();
  if (!row) throw new Error("booking row missing");
  return { body, row, purchase: chip.byReference(body.refCode) };
}

async function deliver(id: string, eventType?: string, signature?: string) {
  return world.app.fetch(await chip.callback(id, eventType, signature), TEST_ENV);
}

async function locksOf(bookingId: string) {
  const { results } = await db
    .prepare(
      "SELECT unit_id, date, kind, hold_expires_at FROM availability_locks WHERE booking_id = ? ORDER BY date",
    )
    .bind(bookingId)
    .all<{ unit_id: string; date: string; kind: string; hold_expires_at: string | null }>();
  return results;
}

async function ledgerOf(bookingId: string) {
  const { results } = await db
    .prepare("SELECT type, amount_sen FROM ledger_entries WHERE booking_id = ? ORDER BY type")
    .bind(bookingId)
    .all<{ type: string; amount_sen: number }>();
  return results;
}

describe("GET /api/config", () => {
  it("publishes what the wizard needs and says booking is open", async () => {
    const response = await call(world.app, "/api/config");
    expect(response.status).toBe(200);
    const body: Record<string, unknown> = await response.json();
    expect(body).toMatchObject({
      bookingOpen: true,
      today: world.today,
      depositSen: 10000,
      minLeadHours: 24,
      maxRentalDays: 7,
    });
    expect((body.slots as unknown[]).length).toBe(2);
  });

  it("says booking is closed without a payment provider", async () => {
    const closed = bookingWorld(null);
    const body: { bookingOpen: boolean } = await (await call(closed.app, "/api/config")).json();
    expect(body.bookingOpen).toBe(false);
  });
});

describe("POST /api/quote", () => {
  it("prices the period on the server and says it is free", async () => {
    const response = await post("/api/quote", period(world.today));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      rentalDays: 2,
      available: true,
      breakdown: { rentalSen: 12000, addOnsSen: 500, depositSen: 10000, totalPayableSen: 22500 },
      includedItems: [{ code: "MAGNETIC_FILTER_BASE" }],
    });
  });

  it("refuses a phone number and client-sent prices", async () => {
    for (const extra of [{ phone: "0123456789" }, { totalSen: 1 }]) {
      const response = await post("/api/quote", { ...period(world.today), ...extra });
      expect(response.status).toBe(400);
    }
  });

  it("names the field to fix, in Bahasa Melayu", async () => {
    const response = await post("/api/quote", {
      ...period(world.today),
      pickupSlotId: "tengah-malam",
    });
    expect(response.status).toBe(400);
    const body: { error: { fields: Record<string, string> } } = await response.json();
    expect(body.error.fields.pickupSlotId).toMatch(/slot ambil/);
  });

  it("refuses a pickup inside the lead time", async () => {
    const response = await post("/api/quote", period(world.today, 0, 1));
    const body: { error: { fields: Record<string, string> } } = await response.json();
    expect(body.error.fields.pickupDate).toMatch(/lebih awal/);
  });

  it("reports unavailable once every unit is held", async () => {
    await heldBooking();
    await heldBooking();
    const body: { available: boolean } = await (
      await post("/api/quote", period(world.today))
    ).json();
    expect(body.available).toBe(false);
  });
});

describe("GET /api/availability", () => {
  it("lists days with no free unit, and nothing about how many units exist", async () => {
    await heldBooking();
    const from = world.today;
    const to = addDays(world.today, 10);
    let body: { unavailable: string[] } = await (
      await call(world.app, `/api/availability?from=${from}&to=${to}`)
    ).json();
    expect(body.unavailable).toEqual([]);

    await heldBooking();
    body = await (await call(world.app, `/api/availability?from=${from}&to=${to}`)).json();
    expect(body.unavailable).toEqual([2, 3, 4].map((offset) => addDays(world.today, offset)));
  });

  it.each([
    ["a reversed range", (t: string) => `from=${addDays(t, 5)}&to=${t}`],
    ["a range that is too long", (t: string) => `from=${t}&to=${addDays(t, 80)}`],
    ["a bad date", () => "from=2026-02-30&to=2026-03-01"],
  ])("rejects %s", async (_label, query) => {
    expect((await call(world.app, `/api/availability?${query(world.today)}`)).status).toBe(400);
  });

  it("clips the range to today", async () => {
    const body: { from: string } = await (
      await call(world.app, `/api/availability?from=${addDays(world.today, -3)}&to=${world.today}`)
    ).json();
    expect(body.from).toBe(world.today);
  });
});

describe("POST /api/bookings/hold", () => {
  it("locks the days, records the booking and returns a CHIP checkout", async () => {
    const { body, row, purchase } = await heldBooking();
    expect(body.refCode).toMatch(/^PK-[2-9A-HJKMNP-Z]{6}$/);
    expect(body.lookupToken.length).toBeGreaterThanOrEqual(30);
    expect(body.checkoutUrl).toBe(purchase.checkout_url);
    expect(body.breakdown.totalPayableSen).toBe(22500);

    expect(row).toMatchObject({
      status: "pending_payment",
      customer_name: "Nur Aisyah",
      rental_days: 2,
      total_payable_sen: 22500,
      unit_id: "fixture-unit-a",
    });
    // The token itself is never stored.
    expect(row.lookup_token_hash).not.toBe(body.lookupToken);
    expect(row.hold_expires_at).toBe(body.holdExpiresAt);

    const locks = await locksOf(row.id);
    expect(locks.map((lock) => lock.date)).toEqual([2, 3, 4].map((d) => addDays(world.today, d)));
    expect(
      locks.every((lock) => lock.kind === "hold" && lock.hold_expires_at === body.holdExpiresAt),
    ).toBe(true);

    // CHIP is told the server's price, due at the end of the hold.
    expect(purchase.purchase.total).toBe(22500);
    expect(purchase.due).toBe(Math.floor(Date.parse(body.holdExpiresAt) / 1000));
    const create = chip.requests.find((r) => r.path === "/purchases/");
    expect(create?.authorization).toBe("Bearer test-chip-key");
    expect(create?.body).toMatchObject({
      brand_id: "test-brand",
      reference: body.refCode,
      client: { email: "aisyah@example.com", full_name: "Nur Aisyah" },
      purchase: { currency: "MYR", due_strict: true },
      success_callback: "https://lensarent.test/api/webhooks/chip",
    });
  });

  it("gives the second hold on the same days the second unit, then refuses", async () => {
    const first = await heldBooking();
    const second = await heldBooking();
    expect(first.row.unit_id).not.toBe(second.row.unit_id);
    const third = await hold();
    expect(third.status).toBe(409);
    expect(await third.json()).toMatchObject({ error: { code: "SLOT_UNAVAILABLE" } });
  });

  it("lets exactly one request per unit win a race for the same days", async () => {
    const { results } = await db
      .prepare("SELECT COUNT(*) AS n FROM units WHERE status = 'active'")
      .all<{ n: number }>();
    const units = results[0]?.n ?? 0;

    const responses = await Promise.all(Array.from({ length: 20 }, () => hold()));
    const statuses = responses.map((response) => response.status);
    expect(statuses.filter((status) => status === 201)).toHaveLength(units);
    expect(statuses.filter((status) => status === 409)).toHaveLength(20 - units);

    const { results: locks } = await db
      .prepare(
        `SELECT unit_id, COUNT(*) AS days, COUNT(DISTINCT booking_id) AS owners
         FROM availability_locks WHERE date IN (?, ?, ?) GROUP BY unit_id`,
      )
      .bind(...[2, 3, 4].map((d) => addDays(world.today, d)))
      .all<{ unit_id: string; days: number; owners: number }>();
    expect(locks).toHaveLength(units);
    expect(locks.every((lock) => lock.days === 3 && lock.owners === 1)).toBe(true);
  });

  it("frees the days and cancels the booking when CHIP refuses the purchase", async () => {
    chip.failNextCreate = 500;
    const response = await hold();
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: "PAYMENT_UNAVAILABLE" } });

    const { results } = await db
      .prepare(
        "SELECT id, status, status_reason, hold_expires_at FROM bookings WHERE pickup_at = ?",
      )
      .bind(new Date(Date.parse(`${addDays(world.today, 2)}T02:00:00.000Z`)).toISOString())
      .all<{ id: string; status: string; status_reason: string; hold_expires_at: string | null }>();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      status: "cancelled",
      status_reason: "checkout_failed",
      hold_expires_at: null,
    });
    expect(await locksOf(results[0]?.id ?? "")).toEqual([]);

    // The days are free again.
    await heldBooking();
    await heldBooking();
  });

  it("is closed without a payment provider", async () => {
    const closed = bookingWorld(null);
    const response = await hold({}, closed);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "BOOKING_CLOSED" } });
  });

  it("refuses a failed Turnstile check before writing anything", async () => {
    const response = await hold({ turnstileToken: "bot" });
    expect(response.status).toBe(403);
    expect(chip.requests).toEqual([]);
  });

  it("validates the form with a message per field", async () => {
    const response = await hold({ email: "bukan-emel", consent: { terms: true, privacy: false } });
    expect(response.status).toBe(400);
    const body: { error: { fields: Record<string, string> } } = await response.json();
    expect(Object.keys(body.error.fields).sort()).toEqual(["consent", "email"]);
  });

  it("refuses a blocked customer with a generic message", async () => {
    const { row } = await heldBooking();
    await db.prepare("UPDATE customers SET blocked = 1 WHERE id = ?").bind(row.customer_id).run();
    const response = await hold({ phone: row.customer_phone_e164, ...period(world.today, 10) });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "BOOKING_NOT_ALLOWED" } });
  });

  it("limits how many unpaid holds one phone can keep open", async () => {
    const { row } = await heldBooking();
    const phone = row.customer_phone_e164;
    expect((await hold({ phone, ...period(world.today, 10) })).status).toBe(201);
    const third = await hold({ phone, ...period(world.today, 20) });
    expect(third.status).toBe(409);
    expect(await third.json()).toMatchObject({ error: { code: "TOO_MANY_HOLDS" } });
  });

  it("does not overwrite an existing customer's name or email", async () => {
    const { row } = await heldBooking();
    await hold({
      phone: row.customer_phone_e164,
      name: "Orang Lain",
      email: "lain@example.com",
      ...period(world.today, 10),
    });
    const customer = await db
      .prepare("SELECT name, email FROM customers WHERE id = ?")
      .bind(row.customer_id)
      .first();
    expect(customer).toEqual({ name: "Nur Aisyah", email: "aisyah@example.com" });
  });

  it("refuses a test-mode purchase in production and cancels it", async () => {
    const request = holdRequestSchema.parse(holdBody(world.today));
    const plan = planBooking(request, TEST_SETTINGS, "new", world.now);
    if (!plan.ok) throw new Error("plan failed");
    const customer = await upsertCustomer(db, {
      phoneHash: `h-${crypto.randomUUID()}`,
      name: request.name,
      phoneE164: request.phone,
      email: request.email,
      now: world.now,
    });
    const created = await createHold(db, {
      request,
      plan: plan.value,
      customer,
      consentIpHash: "ip",
      settings: TEST_SETTINGS,
      now: world.now,
    });
    if (!created) throw new Error("hold failed");
    const provider = createChipProvider({
      secretKey: "k",
      brandId: "b",
      publicKeyPem: chip.publicKeyPem,
      fetch: chip.fetch,
    });
    const result = await startPayment(db, provider, logger, {
      hold: created,
      request,
      plan: plan.value,
      origin: "https://lensarent.test",
      production: true,
      now: world.now,
    });
    expect(result).toBeNull();
    expect(chip.byReference(created.refCode).status).toBe("cancelled");
    expect((await getBooking(db, created.bookingId))?.status).toBe("cancelled");
  });
});

describe("POST /api/webhooks/chip", () => {
  it("confirms a paid booking: locks, payment, ledger, receipt and emails in one go", async () => {
    const { row, purchase } = await heldBooking();
    chip.pay(purchase.id, { fee: 120 });
    const response = await deliver(purchase.id);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, result: "confirmed" });

    const booking = await getBooking(db, row.id);
    expect(booking).toMatchObject({
      status: "confirmed",
      hold_expires_at: null,
      status_reason: "paid",
    });
    expect(booking?.receipt_no).toMatch(/^R-\d{4}-\d{5}$/);

    const locks = await locksOf(row.id);
    expect(locks).toHaveLength(3);
    expect(locks.every((lock) => lock.kind === "booking" && lock.hold_expires_at === null)).toBe(
      true,
    );

    expect(await ledgerOf(row.id)).toEqual([
      { type: "ADD_ON", amount_sen: 500 },
      { type: "DEPOSIT_IN", amount_sen: 10000 },
      { type: "GATEWAY_FEE", amount_sen: -120 },
      { type: "RENTAL", amount_sen: 12000 },
    ]);

    const payment = await db
      .prepare("SELECT status, paid_sen, fee_sen FROM payments WHERE provider_ref = ?")
      .bind(purchase.id)
      .first();
    expect(payment).toEqual({ status: "paid", paid_sen: 22500, fee_sen: 120 });

    const { results: outbox } = await db
      .prepare(
        "SELECT template, to_address FROM notifications_outbox WHERE payload = ? ORDER BY template",
      )
      .bind(JSON.stringify({ bookingId: row.id }))
      .all();
    expect(outbox).toEqual([
      { template: "admin_new_booking", to_address: "admin@lensarent.test" },
      { template: "booking_confirmed", to_address: "aisyah@example.com" },
    ]);

    const { results: events } = await db
      .prepare(
        "SELECT from_status, to_status, actor_type FROM booking_events WHERE booking_id = ? ORDER BY at, from_status",
      )
      .bind(row.id)
      .all();
    expect(events).toContainEqual({
      from_status: "pending_payment",
      to_status: "confirmed",
      actor_type: "webhook",
    });
  });

  it("processes a repeated or concurrent delivery once", async () => {
    const { row, purchase } = await heldBooking();
    chip.pay(purchase.id);
    const results = await Promise.all(
      Array.from({ length: 5 }, async () =>
        (await deliver(purchase.id)).json<{ result: string }>(),
      ),
    );
    expect(results.filter((r) => r.result === "confirmed")).toHaveLength(1);
    expect((await deliver(purchase.id)).status).toBe(200);
    expect(await ledgerOf(row.id)).toHaveLength(3);
  });

  it("numbers receipts in sequence", async () => {
    const receipts: string[] = [];
    for (const offset of [2, 12]) {
      const { row, purchase } = await heldBooking(period(world.today, offset));
      chip.pay(purchase.id);
      await deliver(purchase.id);
      receipts.push((await getBooking(db, row.id))?.receipt_no ?? "");
    }
    const [first, second] = receipts.map((receipt) => Number(receipt.slice(-5)));
    expect(second).toBeGreaterThan(first ?? Infinity);
  });

  it("moves a wrong amount to refund_pending, frees the days and alerts the admin", async () => {
    const { row, purchase } = await heldBooking();
    chip.pay(purchase.id, { amount: 100 });
    const body: { result: string } = await (await deliver(purchase.id)).json();
    expect(body.result).toBe("mismatch");
    expect(await getBooking(db, row.id)).toMatchObject({
      status: "refund_pending",
      status_reason: "payment_amount",
    });
    expect(await locksOf(row.id)).toEqual([]);
    expect(await ledgerOf(row.id)).toEqual([]);
    const alert = await db
      .prepare("SELECT template FROM notifications_outbox WHERE dedupe_key = ?")
      .bind(`admin_payment_problem:${row.id}:admin@lensarent.test`)
      .first();
    expect(alert).toEqual({ template: "admin_payment_problem" });
  });

  it("rejects a bad signature without touching anything", async () => {
    const { row, purchase } = await heldBooking();
    chip.pay(purchase.id);
    const response = await deliver(purchase.id, "purchase.paid", btoa("forged"));
    expect(response.status).toBe(401);
    expect((await getBooking(db, row.id))?.status).toBe("pending_payment");
  });

  it("does not trust the callback body: an unpaid purchase stays pending", async () => {
    const { row, purchase } = await heldBooking();
    const body: { result: string } = await (await deliver(purchase.id)).json();
    expect(body.result).toBe("not_paid");
    expect((await getBooking(db, row.id))?.status).toBe("pending_payment");
    // Not recorded as processed: the real payment callback still counts.
    chip.pay(purchase.id);
    expect(await (await deliver(purchase.id)).json()).toMatchObject({ result: "confirmed" });
  });

  it("ignores other event types", async () => {
    const { purchase } = await heldBooking();
    const body: { result: string } = await (await deliver(purchase.id, "purchase.created")).json();
    expect(body.result).toBe("ignored");
  });

  it("answers 404 for a purchase it does not know, so CHIP retries", async () => {
    const { purchase } = await heldBooking();
    await db
      .prepare("UPDATE payments SET provider_ref = ? WHERE provider_ref = ?")
      .bind(`x-${purchase.id}`, purchase.id)
      .run();
    chip.pay(purchase.id);
    expect((await deliver(purchase.id)).status).toBe(404);
  });

  it("records a payment that lands on a closed booking and alerts the admin", async () => {
    const { row, purchase } = await heldBooking();
    const booking = await getBooking(db, row.id);
    if (!booking) throw new Error("missing");
    await runTransition(
      db,
      prepareTransition(db, booking, {
        to: "cancelled",
        actor: { type: "admin", id: "a", email: "admin@lensarent.test" },
        reason: "test",
        now: world.now,
      }),
    );
    chip.pay(purchase.id);
    expect(await (await deliver(purchase.id)).json()).toMatchObject({ result: "paid_after_close" });
    const payment = await db
      .prepare("SELECT status FROM payments WHERE provider_ref = ?")
      .bind(purchase.id)
      .first();
    expect(payment).toEqual({ status: "paid" });
  });
});

describe("GET /api/bookings/lookup", () => {
  function lookup(ref: string, token: string) {
    return call(world.app, `/api/bookings/lookup?ref=${encodeURIComponent(ref)}`, {
      headers: { "x-booking-token": token },
    });
  }

  it("shows the booking to the holder of its token", async () => {
    const { body } = await heldBooking();
    const response = await lookup(body.refCode, body.lookupToken);
    expect(response.status).toBe(200);
    const view: Record<string, unknown> = await response.json();
    expect(view).toMatchObject({
      refCode: body.refCode,
      status: "pending_payment",
      checkoutUrl: body.checkoutUrl,
    });
    // No personal data in the view.
    expect(JSON.stringify(view)).not.toMatch(/Aisyah|example\.com|\+601/);
  });

  it("shows the receipt once paid, and no checkout link", async () => {
    const { body, purchase } = await heldBooking();
    chip.pay(purchase.id);
    await deliver(purchase.id);
    const view: Record<string, unknown> = await (
      await lookup(body.refCode, body.lookupToken)
    ).json();
    expect(view).toMatchObject({ status: "confirmed", checkoutUrl: null });
    expect(view.receiptNo).toMatch(/^R-/);
  });

  it("gives the same 404 for a wrong token, an unknown reference and a malformed one", async () => {
    const { body } = await heldBooking();
    const wrong = `${body.lookupToken.slice(0, -1)}${body.lookupToken.endsWith("A") ? "B" : "A"}`;
    for (const [ref, token] of [
      [body.refCode, wrong],
      ["PK-222222", body.lookupToken],
      ["nonsense", body.lookupToken],
      [body.refCode, ""],
    ] as const) {
      const response = await lookup(ref, token);
      expect(response.status).toBe(404);
    }
  });
});

describe("booking transitions", () => {
  it("refuse a change the state machine does not allow", async () => {
    const { row } = await heldBooking();
    expect(() =>
      prepareTransition(
        db,
        { id: row.id, status: "pending_payment" },
        {
          to: "completed",
          actor: { type: "admin", id: "a" },
          now: world.now,
        },
      ),
    ).toThrow(InvalidTransitionError);
  });

  it("apply nothing when the booking moved on first", async () => {
    const { row } = await heldBooking();
    const actor = { type: "admin" as const, id: "a", email: "admin@lensarent.test" };
    const first = prepareTransition(
      db,
      { id: row.id, status: "pending_payment" },
      { to: "cancelled", actor, now: world.now },
    );
    const second = prepareTransition(
      db,
      { id: row.id, status: "pending_payment" },
      { to: "cancelled", actor, now: world.now },
    );
    await runTransition(db, first);
    await expect(runTransition(db, second)).rejects.toThrow(StaleBookingError);
    const { results } = await db
      .prepare(
        "SELECT COUNT(*) AS n FROM booking_events WHERE booking_id = ? AND to_status = 'cancelled'",
      )
      .bind(row.id)
      .all<{ n: number }>();
    expect(results[0]?.n).toBe(1);
    const audits = await db
      .prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE target_id = ?")
      .bind(row.id)
      .first<{ n: number }>();
    expect(audits?.n).toBe(1);
  });

  it("refuse to set a column that is not on the allow-list", async () => {
    const { row } = await heldBooking();
    expect(() =>
      prepareTransition(
        db,
        { id: row.id, status: "pending_payment" },
        {
          to: "cancelled",
          actor: { type: "system", id: "s" },
          now: world.now,
          set: { total_payable_sen: 0 },
        },
      ),
    ).toThrow(/cannot be set/);
  });
});
