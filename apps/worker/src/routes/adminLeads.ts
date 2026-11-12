import type { LeadDocument, LeadStatus } from "@lensarent/shared";
import {
  LEAD_SOURCE_LABELS,
  LEAD_STATUSES,
  LEAD_STATUS_LABELS,
  LEAD_USAGE_LABELS,
  addDays,
  dateStringSchema,
  formatMyMobile,
  leadDocumentSchema,
  leadUpdateSchema,
  mytDateString,
  mytDateTime,
} from "@lensarent/shared";
import { z } from "zod";
import { auditWrite } from "../lib/audit";
import { toCsv } from "../lib/csv";
import type { Firestore, QuerySpec } from "../lib/firestore";
import { isFirestoreError, serverTimestamp, updateDoc } from "../lib/firestore";
import {
  API_SECURITY_HEADERS,
  errorResponse,
  jsonResponse,
  readJson,
  validationErrorResponse,
} from "../lib/http";
import type { Logger } from "../lib/logger";
import type { Handler } from "../router";
import { requireAdmin } from "./adminAuth";
import { fieldErrors } from "./validation";

const LEAD_ID = /^[A-Za-z0-9]{20}$/;
const PAGE_DEFAULT = 50;
const PAGE_MAX = 200;
const EXPORT_MAX_ROWS = 5000;
const EXPORT_PAGE = 1000;

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

const listSchema = z.object({
  /** Keyset cursor: only leads submitted strictly before this instant. */
  before: z.iso.datetime().optional(),
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

export interface LeadView {
  id: string;
  name: string;
  phoneE164: string;
  desiredDate: string | null;
  usage: LeadDocument["usage"];
  source: LeadDocument["source"];
  status: LeadStatus;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

async function queryLeads(
  db: Firestore,
  filter: LeadFilter,
  before: Date | undefined,
  limit: number,
  logger: Logger,
): Promise<LeadView[]> {
  const where: NonNullable<QuerySpec["where"]>[number][] = [];
  if (filter.status) where.push(["status", "==", filter.status]);
  if (filter.from) where.push(["createdAt", ">=", mytDateTime(filter.from)]);
  const upperBounds = [
    ...(filter.to ? [mytDateTime(addDays(filter.to, 1))] : []),
    ...(before ? [before] : []),
  ];
  if (upperBounds.length > 0) {
    where.push([
      "createdAt",
      "<",
      new Date(Math.min(...upperBounds.map((date) => date.getTime()))),
    ]);
  }

  // Index: leads (status ASC, createdAt DESC) — firebase/firestore.indexes.json.
  const snapshots = await db.query({
    collection: "leads",
    where,
    orderBy: [["createdAt", "desc"]],
    limit,
  });

  return snapshots.flatMap((snapshot) => {
    const parsed = leadDocumentSchema.safeParse(snapshot.data);
    if (!parsed.success) {
      logger.error("lead.unreadable", { leadId: snapshot.id });
      return [];
    }
    const lead = parsed.data;
    return [
      {
        id: snapshot.id,
        name: lead.name,
        phoneE164: lead.phoneE164,
        desiredDate: lead.desiredDate,
        usage: lead.usage,
        source: lead.source,
        status: lead.status,
        notes: lead.notes,
        createdAt: lead.createdAt.toISOString(),
        updatedAt: lead.updatedAt.toISOString(),
      },
    ];
  });
}

/** GET /api/admin/leads?status=&from=&to=&before=&limit= — newest first. */
export const listLeadsHandler: Handler = async (context) => {
  const auth = await requireAdmin(context, { mutating: false });
  if ("response" in auth) return auth.response;

  const params = searchParams(context.url);
  const filter = filterSchema.safeParse(params);
  const page = listSchema.safeParse(params);
  if (!filter.success) return validationErrorResponse(fieldErrors(filter.error, FILTER_MESSAGES));
  if (!page.success) return validationErrorResponse(fieldErrors(page.error, FILTER_MESSAGES));

  const leads = await queryLeads(
    context.services.db,
    filter.data,
    page.data.before ? new Date(page.data.before) : undefined,
    page.data.limit,
    context.logger,
  );
  const last = leads.at(-1);
  return jsonResponse({
    leads,
    nextBefore: leads.length === page.data.limit && last ? last.createdAt : null,
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

  const rows: LeadView[] = [];
  let before: Date | undefined;
  while (rows.length < EXPORT_MAX_ROWS) {
    const page = await queryLeads(
      context.services.db,
      filter.data,
      before,
      EXPORT_PAGE,
      context.logger,
    );
    rows.push(...page);
    const last = page.at(-1);
    if (page.length < EXPORT_PAGE || !last) break;
    before = new Date(last.createdAt);
  }

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
    ...rows
      .slice(0, EXPORT_MAX_ROWS)
      .map((lead) => [
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

  context.logger.info("admin.leads_exported", { actorId: auth.session.uid, rows: rows.length });
  const filename = `leads-${mytDateString(context.services.now())}.csv`;
  return new Response(csv, {
    headers: {
      ...API_SECURITY_HEADERS,
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
};

/** PUT /api/admin/leads/:id — change status and/or notes. Audited in the same commit. */
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

  const changes: Record<string, string> = {};
  if (parsed.data.status !== undefined) changes.status = parsed.data.status;
  if (parsed.data.notes !== undefined) changes.notes = parsed.data.notes;
  try {
    await context.services.db.commit([
      updateDoc(`leads/${leadId}`, { ...changes, updatedAt: serverTimestamp() }),
      auditWrite({
        actorId: auth.session.uid,
        action: "lead.update",
        targetCollection: "leads",
        targetId: leadId,
        changedFields: Object.keys(changes),
      }),
    ]);
  } catch (error) {
    if (isFirestoreError(error, "NOT_FOUND")) return errorResponse("NOT_FOUND");
    throw error;
  }
  return jsonResponse({ ok: true });
};
