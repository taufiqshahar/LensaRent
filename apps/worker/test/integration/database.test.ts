import { describe, expect, it } from "vitest";
import { isUniqueViolation } from "../../src/lib/db";
import { LEAD_SOURCES, LEAD_STATUSES, LEAD_USAGES } from "@lensarent/shared";
import { RATE_LIMIT_RULES, hitRateLimit } from "../../src/lib/rateLimit";
import { testDb, uniqueId } from "../helpers";

const db = testDb();
const at = "2026-12-01T12:00:00.000Z";

function leadId(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 20);
}

function insertLead(overrides: Record<string, string | null> = {}): D1PreparedStatement {
  const row = {
    id: leadId(),
    name: "Ujian",
    phone_e164: "+60174913169",
    usage: "vlog",
    source: "other",
    status: "new",
    desired_date: null,
    ...overrides,
  };
  return db
    .prepare(
      `INSERT INTO leads (id, name, phone_e164, phone_hash, desired_date, usage, source, status,
         privacy_version, consent_at, created_at, updated_at)
       VALUES (?, ?, ?, 'h', ?, ?, ?, ?, 'v', ?, ?, ?)`,
    )
    .bind(
      row.id,
      row.name,
      row.phone_e164,
      row.desired_date,
      row.usage,
      row.source,
      row.status,
      at,
      at,
      at,
    );
}

describe("D1 batch semantics the system relies on", () => {
  it("rolls back every statement of a batch when one fails", async () => {
    const id = leadId();
    const first = insertLead({ id });
    await expect(db.batch([insertLead(), first, insertLead({ id })])).rejects.toThrow();
    const row = await db.prepare("SELECT id FROM leads WHERE id = ?").bind(id).first();
    expect(row).toBeNull();
  });

  it("reports a duplicate key in a way isUniqueViolation recognises", async () => {
    const key = uniqueId("k");
    const insert = () =>
      db
        .prepare("INSERT INTO rate_limits (key, count, expires_at) VALUES (?, 1, ?)")
        .bind(key, at)
        .run();
    await insert();
    const error = await insert().catch((caught: unknown) => caught);
    expect(isUniqueViolation(error)).toBe(true);
    expect(isUniqueViolation(new Error("something else"))).toBe(false);
    expect(isUniqueViolation("not an error")).toBe(false);
  });
});

describe("schema constraints", () => {
  it("accept every value the shared enums allow", async () => {
    await db.batch([
      ...LEAD_USAGES.map((usage) => insertLead({ usage })),
      ...LEAD_SOURCES.map((source) => insertLead({ source })),
      ...LEAD_STATUSES.map((status) => insertLead({ status })),
    ]);
  });

  it.each([
    ["an unknown usage", { usage: "drone" }],
    ["an unknown source", { source: "radio" }],
    ["an unknown status", { status: "won" }],
    ["a landline", { phone_e164: "+6045931234" }],
    ["a one-letter name", { name: "A" }],
    ["a malformed date", { desired_date: "24/12/2026" }],
    ["a short id", { id: "short" }],
  ])("reject %s", async (_label, override) => {
    await expect(insertLead(override).run()).rejects.toThrow(/CHECK constraint failed/);
  });

  it("allow one owner per lock: a booking or a maintenance block", async () => {
    const insert = (
      kind: string,
      bookingId: string | null,
      blockId: string | null,
      expires: string | null,
    ) =>
      db
        .prepare(
          `INSERT INTO availability_locks (unit_id, date, kind, booking_id, block_id, hold_expires_at, created_at)
           VALUES (?, '2026-12-24', ?, ?, ?, ?, ?)`,
        )
        .bind(uniqueId("u"), kind, bookingId, blockId, expires, at)
        .run();
    await expect(insert("hold", "bk", null, at)).resolves.toBeTruthy();
    await expect(insert("booking", "bk", null, null)).resolves.toBeTruthy();
    await expect(insert("maintenance", null, "blk", null)).resolves.toBeTruthy();
    await expect(insert("maintenance", "bk", null, null)).rejects.toThrow(/CHECK/);
    await expect(insert("booking", "bk", "blk", null)).rejects.toThrow(/CHECK/);
    await expect(insert("booking", "bk", null, at)).rejects.toThrow(/CHECK/);
    await expect(insert("hold", "bk", null, null)).rejects.toThrow(/CHECK/);
  });

  it("keep the audit log append-only", async () => {
    const id = uniqueId("audit");
    await db
      .prepare(
        `INSERT INTO audit_logs (id, actor_id, actor_email, action, target_table, target_id, at)
         VALUES (?, 'a', 'a@b.co', 'x', 't', 'i', ?)`,
      )
      .bind(id, at)
      .run();
    await expect(
      db.prepare("UPDATE audit_logs SET action = 'y' WHERE id = ?").bind(id).run(),
    ).rejects.toThrow(/append-only/);
    await expect(db.prepare("DELETE FROM audit_logs WHERE id = ?").bind(id).run()).rejects.toThrow(
      /append-only/,
    );
  });
});

describe("rate limits", () => {
  const rule = RATE_LIMIT_RULES.leadPerPhone;

  it("counts exactly under concurrency", async () => {
    const key = uniqueId("rl").replaceAll("-", "_");
    const now = new Date();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => hitRateLimit(db, rule, key, now)),
    );
    expect(results.filter((result) => result.allowed)).toHaveLength(rule.limit);
    expect(results.every((result) => result.retryAfterSeconds > 0)).toBe(true);
  });

  it("starts again in the next window and cleans up expired counters", async () => {
    const key = uniqueId("rl").replaceAll("-", "_");
    const start = new Date("2026-12-01T00:00:00.000Z");
    for (let i = 0; i < rule.limit; i++) await hitRateLimit(db, rule, key, start);
    expect((await hitRateLimit(db, rule, key, start)).allowed).toBe(false);

    const nextDay = new Date(start.getTime() + rule.windowSeconds * 1000);
    expect((await hitRateLimit(db, rule, key, nextDay)).allowed).toBe(true);
    const old = await db
      .prepare("SELECT COUNT(*) AS n FROM rate_limits WHERE key LIKE ? AND expires_at <= ?")
      .bind(`%${key}%`, nextDay.toISOString())
      .first<{ n: number }>();
    expect(old?.n).toBe(0);
  });

  it("refuses a key that is not a hash", async () => {
    await expect(hitRateLimit(db, rule, "+60174913169", new Date())).rejects.toThrow("hash");
  });
});
