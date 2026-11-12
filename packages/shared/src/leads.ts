import { z } from "zod";
import { normalizeMyMobile } from "./phone";
import { dateStringSchema } from "./schemas";

/**
 * Interest form ("borang minat", Fasa 1). A lead is someone who asked about renting; the
 * operator follows up on WhatsApp. Nothing here is a booking.
 */
export const LEAD_USAGES = ["vlog", "travel", "event", "content", "family", "other"] as const;
export type LeadUsage = (typeof LEAD_USAGES)[number];

export const LEAD_SOURCES = [
  "tiktok",
  "instagram",
  "facebook",
  "whatsapp",
  "google",
  "friend",
  "other",
] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

export const LEAD_STATUSES = ["new", "contacted", "converted", "not_interested", "spam"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

/** Customer-facing labels, shared by the form, the admin list and the CSV export. */
export const LEAD_USAGE_LABELS: Record<LeadUsage, string> = {
  vlog: "Vlog / kandungan peribadi",
  travel: "Percutian / pelancongan",
  event: "Majlis (kahwin, tunang, hari jadi)",
  content: "Kandungan perniagaan / media sosial",
  family: "Aktiviti keluarga",
  other: "Lain-lain",
};

export const LEAD_SOURCE_LABELS: Record<LeadSource, string> = {
  tiktok: "TikTok",
  instagram: "Instagram",
  facebook: "Facebook",
  whatsapp: "WhatsApp",
  google: "Carian Google",
  friend: "Kawan / keluarga",
  other: "Lain-lain",
};

export const LEAD_STATUS_LABELS: Record<LeadStatus, string> = {
  new: "Baharu",
  contacted: "Sudah dihubungi",
  converted: "Jadi pelanggan",
  not_interested: "Tidak berminat",
  spam: "Spam",
};

export const LEAD_NAME_MAX = 80;
export const LEAD_NOTES_MAX = 2000;

/** Control characters never belong in a name or a note. */
const NO_CONTROL_CHARS = /^[^\p{Cc}]*$/u;
const NO_CONTROL_CHARS_EXCEPT_NEWLINE = /^(?:[^\p{Cc}]|\n)*$/u;

/** What the public form sends. Unknown fields are rejected. */
export const leadSubmissionSchema = z.strictObject({
  name: z.string().trim().min(2).max(LEAD_NAME_MAX).regex(NO_CONTROL_CHARS),
  phone: z
    .string()
    .max(30)
    .transform((value, context) => {
      const e164 = normalizeMyMobile(value);
      if (e164 === null) {
        context.addIssue({ code: "custom", message: "not a Malaysian mobile number" });
        return z.NEVER;
      }
      return e164;
    }),
  /** Empty means "not sure yet". */
  desiredDate: z
    .union([dateStringSchema, z.literal("")])
    .optional()
    .transform((value) => (value ? value : null)),
  usage: z.enum(LEAD_USAGES),
  source: z.enum(LEAD_SOURCES),
  /** The privacy notice was shown and accepted. */
  consent: z.literal(true),
  turnstileToken: z.string().min(1).max(2048),
});
export type LeadSubmission = z.infer<typeof leadSubmissionSchema>;

/** What an admin may change on a lead. At least one field. */
export const leadUpdateSchema = z
  .strictObject({
    status: z.enum(LEAD_STATUSES).optional(),
    notes: z.string().trim().max(LEAD_NOTES_MAX).regex(NO_CONTROL_CHARS_EXCEPT_NEWLINE).optional(),
  })
  .refine((value) => value.status !== undefined || value.notes !== undefined, {
    message: "nothing to update",
  });
export type LeadUpdate = z.infer<typeof leadUpdateSchema>;

/** A lead as stored in `leads/{leadId}`. */
export const leadDocumentSchema = z.object({
  name: z.string(),
  phoneE164: z.string(),
  phoneHash: z.string(),
  desiredDate: z.string().nullable(),
  usage: z.enum(LEAD_USAGES),
  source: z.enum(LEAD_SOURCES),
  status: z.enum(LEAD_STATUSES),
  notes: z.string(),
  consent: z.object({ privacyVersion: z.string(), at: z.date() }),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type LeadDocument = z.infer<typeof leadDocumentSchema>;
