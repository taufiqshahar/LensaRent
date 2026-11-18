import type { LeadSource, LeadStatus, LeadUsage } from "@lensarent/shared";
import {
  LEAD_SOURCE_LABELS,
  LEAD_STATUSES,
  LEAD_STATUS_LABELS,
  LEAD_USAGE_LABELS,
  addDays,
  dateStringSchema,
  formatMyMobile,
  leadUpdateSchema,
  mytDateString,
  mytDateTime,
} from "@lensarent/shared";
import { z } from "zod";
import { auditStatementIf } from "../lib/audit";
import { toCsv } from "../lib/csv";
import {
  API_SECURITY_HEADERS,
  errorResponse,
  jsonResponse,
  readJson,
  validationErrorResponse,
} from "../lib/http";
import type { Handler } from "../router";
import { requireAdmin } from "./adminAuth";
import { fieldErrors } from "./validation";

const LEAD_ID = /^[A-Za-z0-9]{20}$/;
const PAGE_DEFAULT = 50;
const PAGE_MAX = 200;
const EXPORT_MAX_ROWS = 5000;

const filterSchema = z
  .object({
    status: z.enum(LEAD_STATUSES).optional(),
    /** MYT calendar days, inclusive, on the date the lead was submitted. */
    from: dateStringSchema.optional(),
    to: dateStringSchema.optional(),
  })
  .refine((value) => !value.from || !value.to || value.from <= value.to, {
    message: "from is after to",
    path: ["to"],
  });
type LeadFilter = z.infer<typeof filterSchema>;

/** Keyset cursor `<createdAt>~<id>`: stable paging even when two leads share a timestamp. */
const CURSOR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)~([A-Za-z0-9]{20})$/;

const pageSchema = z.object({
  before: z.string().regex(CURSOR).optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_MAX).default(PAGE_DEFAULT),
});

const FILTER_MESSAGES = {
  status: "Status tidak dikenali.",
  from: "Tarikh mula tidak sah.",
  to: "Tarikh akhir tidak sah atau sebelum tarikh mula.",
  before: "Penanda halaman tidak sah.",
  limit: `Had mesti antara 1 dan ${PAGE_MAX.toString()}.`,
};

function searchParams(url: URL): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [key, value] of url.searchParams) if (value !== "") params[key] = value;
  return params;
}

interface LeadRow {
  id: string;
  name: string;
  phone_e164: string;
  desired_date: string | null;
  usage: LeadUsage;
  source: LeadSource;
  status: LeadStatus;
  notes: string;
  created_at: string;
  updated_at: string;
}

export interface LeadView {
  id: string;
  name: string;
  phoneE164: string;
  desiredDate: string | null;
  usage: LeadUsage;
  source: LeadSource;
  status: LeadStatus;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

function toView(row: LeadRow): LeadView {
  return {
    id: row.id,
    name: row.name,
    phoneE164: row.phone_e164,
    desiredDate: row.desired_date,
    usage: row.usage,
    source: row.source,
    status: row.status,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Newest first. Conditions are built only from validated values, always as bound parameters. */
async function queryLeads(
  db: D1Database,
  filter: LeadFilter,
  before: { createdAt: string; id: string } | undefined,
  limit: number,
): Promise<LeadView[]> {
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (filter.status) {
    conditions.push("status = ?");
    params.push(filter.status);
  }
  if (filter.from) {
    conditions.push("created_at >= ?");
    params.push(mytDateTime(filter.from).toISOString());
  }
  if (filter.to) {
    conditions.push("created_at < ?");
    params.push(mytDateTime(addDays(filter.to, 1)).toISOString());
  }
  if (before) {
    conditions.push("(created_at < ? OR (created_at = ? AND id < ?))");
    params.push(before.createdAt, before.createdAt, before.id);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const { results } = await db
    .prepare(
      `SELECT id, name, phone_e164, desired_date, usage, source, status, notes, created_at, updated_at
       FROM leads ${where} ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .bind(...params, limit)
    .all<LeadRow>();
  return results.map(toView);
}

/** GET /api/admin/leads?status=&from=&to=&before=&limit= — newest first. */
export const listLeadsHandler: Handler = async (context) => {
  const auth = await requireAdmin(context, { mutating: false });
  if ("response" in auth) return auth.response;

  const params = searchParams(context.url);
  const filter = filterSchema.safeParse(params);
  const page = pageSchema.safeParse(params);
  if (!filter.success) return validationErrorResponse(fieldErrors(filter.error, FILTER_MESSAGES));
  if (!page.success) return validationErrorResponse(fieldErrors(page.error, FILTER_MESSAGES));

  const cursor = page.data.before ? CURSOR.exec(page.data.before) : null;
  const leads = await queryLeads(
    context.services.db,
    filter.data,
    cursor ? { createdAt: cursor[1] ?? "", id: cursor[2] ?? "" } : undefined,
    page.data.limit,
  );
  const last = leads.at(-1);
  return jsonResponse({
    leads,
    nextBefore: leads.length === page.data.limit && last ? `${last.createdAt}~${last.id}` : null,
  });
};

const MYT_DATE_TIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kuala_Lumpur",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** GET /api/admin/leads/export?status=&from=&to= — CSV of the filtered leads. */
export const exportLeadsHandler: Handler = async (context) => {
  const auth = await requireAdmin(context, { mutating: false });
  if ("response" in auth) return auth.response;

  const filter = filterSchema.safeParse(searchParams(context.url));
  if (!filter.success) return validationErrorResponse(fieldErrors(filter.error, FILTER_MESSAGES));

  const rows = await queryLeads(context.services.db, filter.data, undefined, EXPORT_MAX_ROWS);
  const csv = toCsv([
    [
      "Dihantar (MYT)",
      "Nama",
      "Telefon",
      "Tarikh diingini",
      "Kegunaan",
      "Sumber",
      "Status",
      "Nota",
    ],
    ...rows.map((lead) => [
      MYT_DATE_TIME.format(new Date(lead.createdAt)),
      lead.name,
      formatMyMobile(lead.phoneE164),
      lead.desiredDate ?? "",
      LEAD_USAGE_LABELS[lead.usage],
      LEAD_SOURCE_LABELS[lead.source],
      LEAD_STATUS_LABELS[lead.status],
      lead.notes,
    ]),
  ]);

  context.logger.info("admin.leads_exported", { rows: rows.length });
  const filename = `leads-${mytDateString(context.services.now())}.csv`;
  return new Response(csv, {
    headers: {
      ...API_SECURITY_HEADERS,
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
};

/** PUT /api/admin/leads/:id — change status and/or notes. Audited in the same transaction. */
export const updateLeadHandler: Handler = async (context) => {
  const auth = await requireAdmin(context, { mutating: true });
  if ("response" in auth) return auth.response;

  const leadId = context.params.id ?? "";
  if (!LEAD_ID.test(leadId)) return errorResponse("NOT_FOUND");

  const body = await readJson(context.request);
  if (!body.ok) return body.response;
  const parsed = leadUpdateSchema.safeParse(body.value);
  if (!parsed.success) {
    return validationErrorResponse(
      fieldErrors(parsed.error, {
        status: "Status tidak dikenali.",
        notes: "Nota terlalu panjang atau mengandungi aksara tidak sah.",
      }),
    );
  }

  const changedFields = [
    ...(parsed.data.status === undefined ? [] : ["status"]),
    ...(parsed.data.notes === undefined ? [] : ["notes"]),
  ];
  const now = context.services.now();
  const db = context.services.db;

  // The audit row is guarded by the same condition as the UPDATE: an UPDATE that matches no
  // row does not fail the batch, so without the guard a missing lead would still be audited.
  const [update] = await db.batch([
    db
      .prepare(
        `UPDATE leads SET status = COALESCE(?, status), notes = COALESCE(?, notes), updated_at = ?
         WHERE id = ?`,
      )
      .bind(parsed.data.status ?? null, parsed.data.notes ?? null, now.toISOString(), leadId),
    auditStatementIf(
      db,
      {
        actor: auth.admin,
        action: "lead.update",
        targetTable: "leads",
        targetId: leadId,
        changedFields,
        at: now,
      },
      "SELECT 1 FROM leads WHERE id = ?",
      [leadId],
    ),
  ]);
  if (!update || update.meta.changes === 0) return errorResponse("NOT_FOUND");
  return jsonResponse({ ok: true });
};

/** GET /api/admin/me — who is signed in (through Cloudflare Access). */
export const currentAdminHandler: Handler = async (context) => {
  const auth = await requireAdmin(context, { mutating: false });
  if ("response" in auth) return auth.response;
  return jsonResponse({ email: auth.admin.email });
};
