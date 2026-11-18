import { addDays, addMinutes, mytDateTime } from "@lensarent/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { getBooking } from "../../src/lib/bookings";
import { sniffImageType } from "../../src/routes/adminPhotos";
import { expirePhotos } from "../../src/scheduled";
import { createServices } from "../../src/services";
import { TEST_ADMIN, TEST_ENV, testConfig, testDb, uniqueId } from "../helpers";
import type { BookingWorld } from "../support/booking";
import { TEST_SETTINGS, bookingWorld, holdBody, period } from "../support/booking";
import type { FakeChip } from "../support/fakeChip";
import { createFakeChip } from "../support/fakeChip";
import { ORIGIN, call, jsonInit, randomIp } from "./app";

const db = testDb();
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

let chip: FakeChip;
let world: BookingWorld;

beforeEach(async () => {
  chip = await createFakeChip();
  world = bookingWorld(chip);
});

function admin(method: string, path: string, body?: unknown) {
  return call(
    world.app,
    path,
    body === undefined ? { method, headers: { origin: ORIGIN } } : jsonInit(method, body),
  );
}

async function json<T = Record<string, unknown>>(response: Response): Promise<T> {
  return response.json();
}

async function confirmedBooking(overrides: Record<string, unknown> = {}) {
  const response = await call(
    world.app,
    "/api/bookings/hold",
    jsonInit("POST", holdBody(world.today, overrides), { "cf-connecting-ip": randomIp() }),
  );
  expect(response.status).toBe(201);
  const { refCode } = await json<{ refCode: string }>(response);
  const purchase = chip.byReference(refCode);
  chip.pay(purchase.id, { fee: 100 });
  await world.app.fetch(await chip.callback(purchase.id), TEST_ENV);
  const row = await db
    .prepare("SELECT id FROM bookings WHERE ref_code = ?")
    .bind(refCode)
    .first<{ id: string }>();
  if (!row) throw new Error("missing");
  return { id: row.id, refCode };
}

function upload(id: string, stage: string, bytes: Uint8Array = JPEG) {
  return call(world.app, `/api/admin/bookings/${id}/photos?stage=${stage}`, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "image/jpeg" },
    body: bytes,
  });
}

async function ledger(id: string) {
  const { results } = await db
    .prepare(
      "SELECT type, amount_sen FROM ledger_entries WHERE booking_id = ? ORDER BY created_at, rowid",
    )
    .bind(id)
    .all<{ type: string; amount_sen: number }>();
  return results;
}

async function depositBalance(id: string) {
  const row = await db
    .prepare(
      "SELECT COALESCE(SUM(amount_sen), 0) AS b FROM ledger_entries WHERE booking_id = ? AND type LIKE 'DEPOSIT_%'",
    )
    .bind(id)
    .first<{ b: number }>();
  return row?.b;
}

describe("a booking's whole life", () => {
  it("goes confirmed → ready → out → back → completed, with the deposit settled", async () => {
    const { id } = await confirmedBooking();
    const detail = await json<{ allowedTransitions: string[]; booking: Record<string, unknown> }>(
      await admin("GET", `/api/admin/bookings/${id}`),
    );
    expect(detail.allowedTransitions).toEqual(["ready_for_pickup", "refund_pending"]);
    expect(detail.booking).not.toHaveProperty("lookup_token_hash");

    expect(
      (
        await admin("POST", `/api/admin/bookings/${id}/transition`, {
          from: "confirmed",
          to: "ready_for_pickup",
        })
      ).status,
    ).toBe(200);

    const handover = {
      from: "ready_for_pickup",
      idLast4: "1234",
      checklist: { lens_clean: true },
      accessories: ["Kabel USB-C"],
    };
    // No photo yet: refused.
    expect(
      await json(await admin("POST", `/api/admin/bookings/${id}/handover`, handover)),
    ).toMatchObject({
      error: { code: "PHOTO_REQUIRED" },
    });
    expect((await upload(id, "checkout")).status).toBe(201);
    expect(
      (
        await admin("POST", `/api/admin/bookings/${id}/handover`, {
          ...handover,
          idLast4: "123456789012",
        })
      ).status,
    ).toBe(400);
    expect((await admin("POST", `/api/admin/bookings/${id}/handover`, handover)).status).toBe(200);
    const out = await getBooking(db, id);
    expect(out).toMatchObject({
      status: "active_rental",
      id_last4: "1234",
      verified_by: TEST_ADMIN,
    });

    // Returned 7 hours after the slot ended: 30 min grace, then two 6-hour blocks of RM15.
    const slotEnd = new Date(out?.return_slot_end ?? "");
    world.clock.now = addMinutes(slotEnd, 7 * 60 + 5);
    expect((await upload(id, "return")).status).toBe(201);
    const back = await json<{ lateFeeSuggestionSen: number }>(
      await admin("POST", `/api/admin/bookings/${id}/return`, {
        from: "active_rental",
        returnedAt: addMinutes(slotEnd, 7 * 60).toISOString(),
        checklist: { lens_clean: true },
        accessories: ["Kabel USB-C"],
      }),
    );
    expect(back.lateFeeSuggestionSen).toBe(3000);

    // Deductions above the deposit are refused.
    expect(
      (
        await admin("POST", `/api/admin/bookings/${id}/settle`, {
          from: "return_inspection",
          lateFeeSen: 3000,
          damageSen: 8000,
          refundMethod: "duitnow",
          refundReference: "DN1",
        })
      ).status,
    ).toBe(400);
    const settled = await admin("POST", `/api/admin/bookings/${id}/settle`, {
      from: "return_inspection",
      lateFeeSen: 3000,
      damageSen: 0,
      refundMethod: "duitnow",
      refundReference: "DN123",
    });
    expect(await json(settled)).toEqual({ ok: true, status: "completed", depositRefundSen: 7000 });
    expect(await depositBalance(id)).toBe(0);
    expect((await ledger(id)).slice(-3)).toEqual([
      { type: "DEPOSIT_DEDUCTION", amount_sen: -3000 },
      { type: "LATE_FEE", amount_sen: 3000 },
      { type: "DEPOSIT_REFUND", amount_sen: -7000 },
    ]);
    const customer = await db
      .prepare(
        "SELECT c.tier, c.completed_count FROM customers c JOIN bookings b ON b.customer_id = c.id WHERE b.id = ?",
      )
      .bind(id)
      .first();
    expect(customer).toEqual({ tier: "returning", completed_count: 1 });
  });

  it("refuses a change made from a stale screen and a transition the state machine forbids", async () => {
    const { id } = await confirmedBooking();
    expect(
      await json(
        await admin("POST", `/api/admin/bookings/${id}/transition`, {
          from: "ready_for_pickup",
          to: "disputed",
        }),
      ),
    ).toMatchObject({
      error: { code: "BOOKING_CHANGED" },
    });
    expect(
      await json(
        await admin("POST", `/api/admin/bookings/${id}/transition`, {
          from: "confirmed",
          to: "disputed",
        }),
      ),
    ).toMatchObject({
      error: { code: "INVALID_TRANSITION" },
    });
    // Targets with their own endpoints are not accepted here.
    expect(
      (
        await admin("POST", `/api/admin/bookings/${id}/transition`, {
          from: "confirmed",
          to: "completed",
        })
      ).status,
    ).toBe(400);
  });

  it("requires the same origin for every change", async () => {
    const { id } = await confirmedBooking();
    const response = await call(world.app, `/api/admin/bookings/${id}/transition`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.test" },
      body: JSON.stringify({ from: "confirmed", to: "ready_for_pickup" }),
    });
    expect(response.status).toBe(403);
  });
});

describe("cancellation and refunds", () => {
  it("cancels a paid booking under the policy, frees its days, and records the refund", async () => {
    const { id } = await confirmedBooking(period(world.today, 10));
    // 10 days ahead: more than 72 hours, so everything back less the gateway's fee.
    const cancelled = await json<{ outcome: { tier: string; refundSen: number } }>(
      await admin("POST", `/api/admin/bookings/${id}/cancel`, {
        from: "confirmed",
        initiator: "customer",
      }),
    );
    expect(cancelled.outcome).toMatchObject({ tier: "FULL_REFUND", refundSen: 22400 });
    expect(await getBooking(db, id)).toMatchObject({
      status: "refund_pending",
      refund_due_sen: 22400,
    });
    const locks = await db
      .prepare("SELECT COUNT(*) AS n FROM availability_locks WHERE booking_id = ?")
      .bind(id)
      .first<{ n: number }>();
    expect(locks?.n).toBe(0);

    expect(
      (
        await admin("POST", `/api/admin/bookings/${id}/refund`, {
          from: "refund_pending",
          amountSen: 99999,
          method: "duitnow",
          reference: "DN9",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await admin("POST", `/api/admin/bookings/${id}/refund`, {
          from: "refund_pending",
          amountSen: 22400,
          method: "duitnow",
          reference: "DN9",
        })
      ).status,
    ).toBe(200);
    expect((await getBooking(db, id))?.status).toBe("refunded");
    expect(await depositBalance(id)).toBe(0);
    const total = (await ledger(id)).reduce((sum, entry) => sum + entry.amount_sen, 0);
    // Kept: nothing, after the gateway fee (100) was paid out of what came in.
    expect(total).toBe(0);
  });

  it("cancels an unpaid hold after making its CHIP purchase unpayable", async () => {
    const response = await call(
      world.app,
      "/api/bookings/hold",
      jsonInit("POST", holdBody(world.today), { "cf-connecting-ip": randomIp() }),
    );
    const { refCode } = await json<{ refCode: string }>(response);
    const row = await db
      .prepare("SELECT id FROM bookings WHERE ref_code = ?")
      .bind(refCode)
      .first<{ id: string }>();
    const id = row?.id ?? "";
    expect(
      (
        await admin("POST", `/api/admin/bookings/${id}/cancel`, {
          from: "pending_payment",
          initiator: "business",
        })
      ).status,
    ).toBe(200);
    expect(chip.byReference(refCode).status).toBe("cancelled");
    expect((await getBooking(db, id))?.status).toBe("cancelled");
  });
});

describe("reschedule", () => {
  it("moves a booking once to free days of the same length", async () => {
    const { id } = await confirmedBooking();
    const moved = await admin("POST", `/api/admin/bookings/${id}/reschedule`, {
      from: "confirmed",
      period: period(world.today, 20),
    });
    expect(await json(moved)).toMatchObject({
      ok: true,
      lockedDates: [20, 21, 22].map((d) => addDays(world.today, d)),
    });
    const again = await admin("POST", `/api/admin/bookings/${id}/reschedule`, {
      from: "confirmed",
      period: period(world.today, 30),
    });
    expect(again.status).toBe(400);
  });

  it("refuses a different price or taken days, and changes nothing", async () => {
    const { id } = await confirmedBooking();
    expect(
      (
        await admin("POST", `/api/admin/bookings/${id}/reschedule`, {
          from: "confirmed",
          period: period(world.today, 20, 3),
        })
      ).status,
    ).toBe(400);

    // Both units busy on days 40–42.
    await confirmedBooking(period(world.today, 40));
    await confirmedBooking(period(world.today, 40));
    const taken = await admin("POST", `/api/admin/bookings/${id}/reschedule`, {
      from: "confirmed",
      period: period(world.today, 40),
    });
    expect(await json(taken)).toMatchObject({ error: { code: "SLOT_UNAVAILABLE" } });
    expect((await getBooking(db, id))?.reschedule_used).toBe(0);
    const locks = await db
      .prepare("SELECT COUNT(*) AS n FROM availability_locks WHERE booking_id = ?")
      .bind(id)
      .first<{ n: number }>();
    expect(locks?.n).toBe(3);
  });
});

describe("ledger corrections", () => {
  it("adds signed entries and reverses an entry exactly once", async () => {
    const { id } = await confirmedBooking();
    expect(
      (
        await admin("POST", `/api/admin/bookings/${id}/ledger`, {
          type: "REFUND",
          amountSen: 500,
          method: "cash",
          note: "salah tanda",
        })
      ).status,
    ).toBe(400);
    const added = await json<{ id: string }>(
      await admin("POST", `/api/admin/bookings/${id}/ledger`, {
        type: "DAMAGE_CHARGE",
        amountSen: 2000,
        method: "cash",
        note: "calar skrin",
      }),
    );
    const reverse = { reversesId: added.id, note: "dikenakan tersilap" };
    expect((await admin("POST", `/api/admin/bookings/${id}/ledger`, reverse)).status).toBe(201);
    expect((await admin("POST", `/api/admin/bookings/${id}/ledger`, reverse)).status).toBe(409);
    const damage = (await ledger(id)).filter((entry) => entry.type === "DAMAGE_CHARGE");
    expect(damage.map((entry) => entry.amount_sen)).toEqual([2000, -2000]);
    const audits = await db
      .prepare("SELECT action FROM audit_logs WHERE target_id = ?")
      .bind(added.id)
      .all();
    expect(audits.results).toEqual([{ action: "ledger.damage_charge" }]);
  });
});

describe("photos", () => {
  it("are sniffed, size-limited, stored privately and served without caching", async () => {
    const { id } = await confirmedBooking();
    await admin("POST", `/api/admin/bookings/${id}/transition`, {
      from: "confirmed",
      to: "ready_for_pickup",
    });
    expect((await upload(id, "checkout", new TextEncoder().encode("<svg onload=x>"))).status).toBe(
      415,
    );
    expect((await upload(id, "nope")).status).toBe(400);
    expect((await upload(id, "return")).status).toBe(409);
    const { id: photoId } = await json<{ id: string }>(await upload(id, "checkout"));
    const photo = await call(world.app, `/api/admin/photos/${photoId}`);
    expect(photo.headers.get("content-type")).toBe("image/jpeg");
    expect(photo.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await photo.arrayBuffer())).toEqual(JPEG);
  });

  it("are deleted once the retention period after closing has passed", async () => {
    const { id } = await confirmedBooking();
    await admin("POST", `/api/admin/bookings/${id}/transition`, {
      from: "confirmed",
      to: "ready_for_pickup",
    });
    const { id: photoId } = await json<{ id: string }>(await upload(id, "checkout"));
    await admin("POST", `/api/admin/bookings/${id}/cancel`, {
      from: "ready_for_pickup",
      initiator: "business",
    });
    await admin("POST", `/api/admin/bookings/${id}/refund`, {
      from: "refund_pending",
      amountSen: 22500,
      method: "duitnow",
      reference: "DN1",
    });

    const config = testConfig();
    const services = { ...createServices(config, TEST_ENV), now: () => world.clock.now };
    const context = {
      config,
      services,
      settings: TEST_SETTINGS,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      now: mytDateTime(addDays(world.today, 40)),
    };
    await expirePhotos(context);
    const row = await db
      .prepare("SELECT deleted_at FROM handover_photos WHERE id = ?")
      .bind(photoId)
      .first<{ deleted_at: string | null }>();
    expect(row?.deleted_at).not.toBeNull();
    expect((await call(world.app, `/api/admin/photos/${photoId}`)).status).toBe(404);
  });

  it("recognise JPEG, PNG and WebP by their bytes only", () => {
    expect(sniffImageType(JPEG)).toBe("image/jpeg");
    expect(sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
      "image/png",
    );
    expect(sniffImageType(new TextEncoder().encode("RIFF0000WEBPVP8 "))).toBe("image/webp");
    expect(sniffImageType(new TextEncoder().encode("GIF89a"))).toBeNull();
  });
});

describe("fleet, customers and settings", () => {
  it("creates units (not active, to keep the shared fleet fixed) and blocks days", async () => {
    const unitId = uniqueId("unit");
    expect(
      (
        await admin("POST", "/api/admin/units", {
          id: unitId,
          name: "Ganti",
          model: "DJI Osmo Pocket 4P",
          status: "maintenance",
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await admin("POST", "/api/admin/units", {
          id: unitId,
          name: "Ganti",
          model: "X",
          status: "retired",
        })
      ).status,
    ).toBe(400);

    const from = addDays(world.today, 3);
    const block = await json<{ id: string }>(
      await admin("POST", "/api/admin/blocks", {
        unitId,
        from,
        to: addDays(from, 2),
        reason: "servis",
      }),
    );
    const clash = await admin("POST", "/api/admin/blocks", {
      unitId,
      from: addDays(from, 2),
      to: addDays(from, 4),
    });
    expect(await json(clash)).toMatchObject({ error: { conflictingDates: [addDays(from, 2)] } });
    const calendar = await json<{ locks: { unit_id: string; kind: string }[] }>(
      await admin("GET", `/api/admin/calendar?from=${from}&to=${addDays(from, 5)}`),
    );
    expect(
      calendar.locks.filter((lock) => lock.unit_id === unitId && lock.kind === "maintenance"),
    ).toHaveLength(3);
    expect((await admin("DELETE", `/api/admin/blocks/${block.id}`)).status).toBe(200);
    expect(
      (
        await admin("POST", "/api/admin/blocks", {
          unitId,
          from: addDays(from, 2),
          to: addDays(from, 4),
        })
      ).status,
    ).toBe(201);
  });

  it("will not retire a unit that still has bookings ahead", async () => {
    const { id } = await confirmedBooking();
    const booking = await getBooking(db, id);
    const unit = await db
      .prepare("SELECT * FROM units WHERE id = ?")
      .bind(booking?.unit_id ?? "")
      .first<{ name: string; model: string }>();
    // The PUT is refused, so the shared fixture unit stays active.
    const response = await admin("PUT", `/api/admin/units/${booking?.unit_id ?? ""}`, {
      name: unit?.name,
      model: unit?.model,
      status: "retired",
    });
    expect(await json(response)).toMatchObject({ error: { code: "UNIT_HAS_BOOKINGS" } });
  });

  it("finds a customer by phone and blocks them", async () => {
    const phone = "0137654321";
    await confirmedBooking({ phone, ...period(world.today, 50) });
    const found = await json<{ customers: { id: string; tier: string }[] }>(
      await admin("GET", `/api/admin/customers?phone=${phone}`),
    );
    const customer = found.customers[0];
    expect(customer).toBeDefined();
    expect(
      (
        await admin("PUT", `/api/admin/customers/${customer?.id ?? ""}`, {
          tier: "verified",
          blocked: true,
          notes: "tidak pulang tepat masa",
        })
      ).status,
    ).toBe(200);
    const after = await json<{ customers: { blocked: number }[] }>(
      await admin("GET", `/api/admin/customers?phone=${phone}`),
    );
    expect(after.customers[0]?.blocked).toBe(1);
  });

  it("edits only the admin-editable settings, validated, with an audit row", async () => {
    expect((await admin("PUT", "/api/admin/settings/pricing", { value: {} })).status).toBe(404);
    expect(
      (await admin("PUT", "/api/admin/settings/holdMinutes", { value: { minutes: 0 } })).status,
    ).toBe(400);
    const settings = await json<{ editable: string[] }>(await admin("GET", "/api/admin/settings"));
    expect(settings.editable).toContain("handoverSlots");
    const log = await json<{ entries: unknown[] }>(await admin("GET", "/api/admin/audit-logs"));
    expect(Array.isArray(log.entries)).toBe(true);
  });

  it("lists bookings by day with keyset paging", async () => {
    await confirmedBooking(period(world.today, 60));
    await confirmedBooking(period(world.today, 60));
    const day = addDays(world.today, 60);
    const first = await json<{ bookings: unknown[]; next: string | null }>(
      await admin("GET", `/api/admin/bookings?day=${day}&limit=1`),
    );
    expect(first.bookings).toHaveLength(1);
    expect(first.next).not.toBeNull();
    const second = await json<{ bookings: unknown[]; next: string | null }>(
      await admin(
        "GET",
        `/api/admin/bookings?day=${day}&limit=1&before=${encodeURIComponent(first.next ?? "")}`,
      ),
    );
    expect(second.bookings).toHaveLength(1);
    expect(second.next).toBeNull();
  });
});
