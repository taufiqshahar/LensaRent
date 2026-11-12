/**
 * Lead option values and their Bahasa Melayu labels. No zod here, so the browser can use
 * these without pulling in the validation library.
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
