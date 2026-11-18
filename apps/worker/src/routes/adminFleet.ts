import {
  ADMIN_EDITABLE_SETTINGS,
  addDays,
  dateStringSchema,
  diffDays,
  eachDate,
  isAdminEditableSetting,
  isDateString,
  mytDateString,
  normalizeMyMobile,
  settingsSchemas,
} from "@lensarent/shared";
import { z } from "zod";
import { auditStatement, auditStatementIf } from "../lib/audit";
import { acquireDayLocks, releaseDayLocks } from "../lib/availabilityLocks";
import { isUniqueViolation, newId } from "../lib/db";
import { errorResponse, jsonResponse, readJson, validationErrorResponse } from "../lib/http";
import { saveSettingStatement } from "../lib/settings";
import type { Handler } from "../router";
import { requireAdmin } from "./adminAuth";
import { fieldErrors } from "./validation";

/**
 * Admin: units, maintenance blocks, the calendar, customers, settings and the audit log.
 * Each change writes its audit row in the same batch (rule: every admin change is audited).
 */
const UNIT_ID = /^[A-Za-z0-9-]{1,40}$/;
const ROW_ID = /^[A-Za-z0-9]{20}$/;
const MAX_CALENDAR_DAYS = 62;

// ── Units ───────────────────────────────────────────────────────────────────────────────

const unitFields = {
  name: z.string().trim().min(1).max(80),
  model: z.string().trim().min(1).max(80),
  serialNumber: z.string().trim().max(80).default(""),
  status: z.enum(["active", "maintenance", "retired"]),
  accessories: z.array(z.string().trim().min(1).max(60)).max(30).default([]),
  sortOrder: z.int().min(0).max(1000).default(0),
};
const createUnitSchema = z.strictObject({ id: z.string().regex(UNIT_ID), ...unitFields });
const updateUnitSchema = z.strictObject(unitFields);
const UNIT_MESSAGES = {
  id: "ID unit: huruf, nombor dan sengkang sahaja (maks. 40).",
  name: "Sila masukkan nama unit.",
  model: "Sila masukkan model.",
};

/** GET /api/admin/units */
export const listUnitsHandler: Handler = async (context) => {
  const auth = await requireAdmin(context, { mutating: false });
  if ("response" in auth) return auth.response;
  const { results } = await context.services.db
    .prepare(
      "SELECT id, name, model, serial_number, status, accessories, sort_order, updated_at FROM units ORDER BY sort_order, id",
    )
    .all<{ accessories: string }>();
  return jsonResponse({
    units: results.map((unit) => ({
      ...unit,
      accessories: JSON.parse(unit.accessories) as unknown,
    })),
  });
};

/** POST /api/admin/units */
export const createUnitHandler: Handler = async (context) => {
  const auth = await requireAdmin(context, { mutating: true });
  if ("response" in auth) return auth.response;
  const body = await readJson(context.request);
  if (!body.ok) return body.response;
  const parsed = createUnitSchema.safeParse(body.value);
  if (!parsed.success) return validationErrorResponse(fieldErrors(parsed.error, UNIT_MESSAGES));
  const unit = parsed.data;
  const db = context.services.db;
  const now = context.services.now();
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO units (id, name, model, serial_number, status, accessories, sort_order, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          unit.id,
          unit.name,
          unit.model,
          unit.serialNumber,
          unit.status,
          JSON.stringify(unit.accessories),
          unit.sortOrder,
          now.toISOString(),
          now.toISOString(),
        ),
      auditStatement(db, {
        actor: auth.admin,
        action: "unit.create",
        targetTable: "units",
        targetId: unit.id,
        changedFields: Object.keys(unit),
        at: now,
      }),
    ]);
  } catch (error) {
    if (isUniqueViolation(error)) return validationErrorResponse({ id: "ID unit sudah wujud." });
    throw error;
  }
  return jsonResponse({ ok: true, id: unit.id }, 201);
};

/**
 * PUT /api/admin/units/:id — a unit with upcoming bookings or holds cannot leave
 * `active`: those customers would lose their camera silently.
 */
export const updateUnitHandler: Handler = async (context) => {
  const auth = await requireAdmin(context, { mutating: true });
  if ("response" in auth) return auth.response;
  const id = context.params.id ?? "";
  if (!UNIT_ID.test(id)) return errorResponse("NOT_FOUND");
  const body = await readJson(context.request);
  if (!body.ok) return body.response;
  const parsed = updateUnitSchema.safeParse(body.value);
  if (!parsed.success) return validationErrorResponse(fieldErrors(parsed.error, UNIT_MESSAGES));
  const unit = parsed.data;
  const db = context.services.db;
  const now = context.services.now();

  if (unit.status !== "active") {
    const upcoming = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM availability_locks
         WHERE unit_id = ? AND kind IN ('hold', 'booking') AND date >= ?`,
      )
      .bind(id, mytDateString(now))
      .first<{ n: number }>();
    if ((upcoming?.n ?? 0) > 0) return errorResponse("UNIT_HAS_BOOKINGS");
  }

  const [update] = await db.batch([
    db
      .prepare(
        `UPDATE units SET name = ?, model = ?, serial_number = ?, status = ?, accessories = ?,
           sort_order = ?, updated_at = ? WHERE id = ?`,
      )
      .bind(
        unit.name,
        unit.model,
        unit.serialNumber,
        unit.status,
        JSON.stringify(unit.accessories),
        unit.sortOrder,
        now.toISOString(),
        id,
      ),
    auditStatementIf(
      db,
      {
        actor: auth.admin,
        action: "unit.update",
        targetTable: "units",
        targetId: id,
        changedFields: Object.keys(unit),
        at: now,
      },
      "SELECT 1 FROM units WHERE id = ?",
      [id],
    ),
  ]);
  if (update?.meta.changes !== 1) return errorResponse("NOT_FOUND");
  return jsonResponse({ ok: true });
};

// ── Maintenance blocks ──────────────────────────────────────────────────────────────────

const blockSchema = z
  .strictObject({
    unitId: z.string().regex(UNIT_ID),
    from: dateStringSchema,
    to: dateStringSchema,
    reason: z.string().trim().max(200).default(""),
  })
  .refine(
    (block) =>
      isDateString(block.from) &&
      isDateString(block.to) &&
      block.from <= block.to &&
      diffDays(block.from, block.to) < 60,
    { message: "range", path: ["to"] },
  );

/** GET /api/admin/blocks — current and future maintenance blocks. */
export const listBlocksHandler: Handler = async (context) => {
  const auth = await requireAdmin(context, { mutating: false });
  if ("response" in auth) return auth.response;
  const { results } = await context.services.db
    .prepare(
      "SELECT id, unit_id, from_date, to_date, reason, created_by, created_at FROM maintenance_blocks WHERE to_date >= ? ORDER BY from_date",
    )
    .bind(mytDateString(context.services.now()))
    .all();
  return jsonResponse({ blocks: results });
};

/** POST /api/admin/blocks — takes a unit out for some days, unless any day is already taken. */
export const createBlockHandler: Handler = async (context) => {
  const auth = await requireAdmin(context, { mutating: true });
  if ("response" in auth) return auth.response;
  const body = await readJson(context.request);
  if (!body.ok) return body.response;
  const parsed = blockSchema.safeParse(body.value);
  if (!parsed.success) {
    return validationErrorResponse(
      fieldErrors(parsed.error, {
        unitId: "Unit tidak sah.",
        from: "Tarikh mula tidak sah.",
        to: "Julat tarikh tidak sah (maks. 60 hari).",
      }),
    );
  }
  const block = parsed.data;
  const db = context.services.db;
  const now = context.services.now();
  const unit = await db.prepare("SELECT id FROM units WHERE id = ?").bind(block.unitId).first();
  if (!unit) return validationErrorResponse({ unitId: "Unit tidak wujud." });

  const id = newId();
  const result = await acquireDayLocks(
    db,
    {
      unitId: block.unitId,
      dates: eachDate(block.from, block.to),
      kind: "maintenance",
      blockId: id,
    },
    now,
    [
      db
        .prepare(
          `INSERT INTO maintenance_blocks (id, unit_id, from_date, to_date, reason, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          block.unitId,
          block.from,
          block.to,
          block.reason,
          auth.admin.email,
          now.toISOString(),
        ),
      auditStatement(db, {
        actor: auth.admin,
        action: "block.create",
        targetTable: "maintenance_blocks",
        targetId: id,
        changedFields: ["unit_id", "from_date", "to_date", "reason"],
        at: now,
      }),
    ],
  );
  if (!result.acquired) {
    return jsonResponse(
      {
        error: {
          code: "SLOT_UNAVAILABLE",
          message: "Ada tempahan pada tarikh ini. Selesaikan tempahan itu dahulu.",
          conflictingDates: result.conflictingDates,
        },
      },
      409,
    );
  }
  return jsonResponse({ ok: true, id }, 201);
};

/** DELETE /api/admin/blocks/:id — frees the block's days. */
export const deleteBlockHandler: Handler = async (context) => {
  const auth = await requireAdmin(context, { mutating: true });
  if ("response" in auth) return auth.response;
  const id = context.params.id ?? "";
  if (!ROW_ID.test(id)) return errorResponse("NOT_FOUND");
  const db = context.services.db;
  const block = await db
    .prepare("SELECT unit_id, from_date, to_date FROM maintenance_blocks WHERE id = ?")
    .bind(id)
    .first<{ unit_id: string; from_date: string; to_date: string }>();
  if (!block) return errorResponse("NOT_FOUND");
  const now = context.services.now();
  await releaseDayLocks(
    db,
    {
      unitId: block.unit_id,
      dates: eachDate(block.from_date, block.to_date),
      owner: { blockId: id },
    },
    [
      auditStatementIf(
        db,
        {
          actor: auth.admin,
          action: "block.delete",
          targetTable: "maintenance_blocks",
          targetId: id,
          at: now,
        },
        "SELECT 1 FROM maintenance_blocks WHERE id = ?",
        [id],
      ),
      db.prepare("DELETE FROM maintenance_blocks WHERE id = ?").bind(id),
    ],
  );
  return jsonResponse({ ok: true });
};

// ── Calendar ────────────────────────────────────────────────────────────────────────────

const calendarSchema = z
  .object({ from: dateStringSchema, to: dateStringSchema })
  .refine(
    (q) =>
      isDateString(q.from) &&
      isDateString(q.to) &&
      q.from <= q.to &&
      diffDays(q.from, q.to) < MAX_CALENDAR_DAYS,
  );

/** GET /api/admin/calendar?from&to — every locked day per unit, with what holds it. */
export const calendarHandler: Handler = async (context) => {
  const auth = await requireAdmin(context, { mutating: false });
  if ("response" in auth) return auth.response;
  const today = mytDateString(context.services.now());
  const parsed = calendarSchema.safeParse({
    from: context.url.searchParams.get("from") ?? today,
    to: context.url.searchParams.get("to") ?? addDays(today, 27),
  });
  if (!parsed.success) return validationErrorResponse({ from: "Julat tarikh tidak sah." });
  const db = context.services.db;
  const [units, locks] = await Promise.all([
    db.prepare("SELECT id, name, status FROM units ORDER BY sort_order, id").all(),
    db
      .prepare(
        `SELECT l.unit_id, l.date, l.kind, l.booking_id, l.block_id, b.ref_code, b.status, m.reason
         FROM availability_locks l
         LEFT JOIN bookings b ON b.id = l.booking_id
         LEFT JOIN maintenance_blocks m ON m.id = l.block_id
         WHERE l.date BETWEEN ? AND ? ORDER BY l.date, l.unit_id`,
      )
      .bind(parsed.data.from, parsed.data.to)
      .all(),
  ]);
  return jsonResponse({ ...parsed.data, units: units.results, locks: locks.results });
};

// ── Customers ───────────────────────────────────────────────────────────────────────────

/**
 * GET /api/admin/customers?phone=… — exact lookup by phone (matched through its hash), or
 * the most recently active customers when no phone is given.
 */
export const listCustomersHandler: Handler = async (context) => {
  const auth = await requireAdmin(context, { mutating: false });
  if ("response" in auth) return auth.response;
  const { db, hasher } = context.services;
  const phone = context.url.searchParams.get("phone");
  const columns =
    "id, name, phone_e164, email, tier, completed_count, blocked, notes, created_at, updated_at";
  if (phone) {
    const e164 = normalizeMyMobile(phone);
    if (!e164) return validationErrorResponse({ phone: "Nombor telefon tidak sah." });
    const row = await db
      .prepare(`SELECT ${columns} FROM customers WHERE phone_hash = ?`)
      .bind(await hasher.hash("phone", e164))
      .first();
    return jsonResponse({ customers: row ? [row] : [] });
  }
  const { results } = await db
    .prepare(`SELECT ${columns} FROM customers ORDER BY updated_at DESC LIMIT 100`)
    .all();
  return jsonResponse({ customers: results });
};

const customerUpdateSchema = z.strictObject({
  tier: z.enum(["new", "verified", "returning"]),
  blocked: z.boolean(),
  notes: z.string().trim().max(2000),
});

/** PUT /api/admin/customers/:id — tier, block flag, private notes. */
export const updateCustomerHandler: Handler = async (context) => {
  const auth = await requireAdmin(context, { mutating: true });
  if ("response" in auth) return auth.response;
  const id = context.params.id ?? "";
  if (!ROW_ID.test(id)) return errorResponse("NOT_FOUND");
  const body = await readJson(context.request);
  if (!body.ok) return body.response;
  const parsed = customerUpdateSchema.safeParse(body.value);
  if (!parsed.success) return validationErrorResponse(fieldErrors(parsed.error, {}));
  const { tier, blocked, notes } = parsed.data;
  const db = context.services.db;
  const now = context.services.now();
  const [update] = await db.batch([
    db
      .prepare("UPDATE customers SET tier = ?, blocked = ?, notes = ?, updated_at = ? WHERE id = ?")
      .bind(tier, blocked ? 1 : 0, notes, now.toISOString(), id),
    auditStatementIf(
      db,
      {
        actor: auth.admin,
        action: "customer.update",
        targetTable: "customers",
        targetId: id,
        changedFields: ["tier", "blocked", "notes"],
        at: now,
      },
      "SELECT 1 FROM customers WHERE id = ?",
      [id],
    ),
  ]);
  if (update?.meta.changes !== 1) return errorResponse("NOT_FOUND");
  return jsonResponse({ ok: true });
};

// ── Settings and audit log ──────────────────────────────────────────────────────────────

/** GET /api/admin/settings — the effective values, and which ones may be edited here. */
export const getSettingsHandler: Handler = async (context) => {
  const auth = await requireAdmin(context, { mutating: false });
  if ("response" in auth) return auth.response;
  return jsonResponse({
    settings: await context.services.settings(),
    editable: ADMIN_EDITABLE_SETTINGS,
  });
};

/** PUT /api/admin/settings/:key {value} — admin-editable keys only (ADR-020). */
export const updateSettingHandler: Handler = async (context) => {
  const auth = await requireAdmin(context, { mutating: true });
  if ("response" in auth) return auth.response;
  const key = context.params.key ?? "";
  if (!isAdminEditableSetting(key)) return errorResponse("NOT_FOUND");
  const body = await readJson(context.request);
  if (!body.ok) return body.response;
  const wrapper = z.strictObject({ value: settingsSchemas[key] }).safeParse(body.value);
  if (!wrapper.success) {
    const problems = wrapper.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.slice(1).join(".") || key}: ${issue.message}`);
    return validationErrorResponse({ value: problems.join("; ") });
  }
  const db = context.services.db;
  const now = context.services.now();
  await db.batch([
    saveSettingStatement(db, key, wrapper.data.value, auth.admin.email, now),
    auditStatement(db, {
      actor: auth.admin,
      action: "settings.update",
      targetTable: "settings",
      targetId: key,
      changedFields: ["value"],
      at: now,
    }),
  ]);
  return jsonResponse({ ok: true });
};

const auditPageSchema = z.object({
  before: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z~[A-Za-z0-9]{20}$/)
    .optional(),
});

/** GET /api/admin/audit-logs?before=<at>~<id> — newest first, 100 per page. */
export const auditLogHandler: Handler = async (context) => {
  const auth = await requireAdmin(context, { mutating: false });
  if ("response" in auth) return auth.response;
  const parsed = auditPageSchema.safeParse({
    before: context.url.searchParams.get("before") ?? undefined,
  });
  if (!parsed.success) return validationErrorResponse({ before: "Penanda halaman tidak sah." });
  const [at = "", id = ""] = parsed.data.before?.split("~") ?? [];
  const { results } = await context.services.db
    .prepare(
      `SELECT id, actor_email, action, target_table, target_id, changed_fields, at FROM audit_logs
       ${parsed.data.before ? "WHERE (at, id) < (?, ?)" : ""} ORDER BY at DESC, id DESC LIMIT 101`,
    )
    .bind(...(parsed.data.before ? [at, id] : []))
    .all<{ id: string; at: string }>();
  const page = results.slice(0, 100);
  const last = page.at(-1);
  return jsonResponse({
    entries: page,
    next: results.length > 100 && last ? `${last.at}~${last.id}` : null,
  });
};
