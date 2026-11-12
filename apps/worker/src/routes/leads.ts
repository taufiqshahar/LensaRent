import type { LeadSubmission } from "@lensarent/shared";
import { DEFAULT_SETTINGS, addDays, leadSubmissionSchema, mytDateString } from "@lensarent/shared";
import { createDoc, newDocumentId, serverTimestamp } from "../lib/firestore";
import {
  clientIp,
  errorResponse,
  jsonResponse,
  rateLimitedResponse,
  readJson,
  validationErrorResponse,
} from "../lib/http";
import { RATE_LIMIT_RULES, hitRateLimit } from "../lib/rateLimit";
import type { Handler } from "../router";
import { fieldErrors } from "./validation";

/** The furthest ahead a customer may say they want the camera. */
const MAX_DESIRED_DAYS_AHEAD = 365;

export const LEAD_FIELD_MESSAGES: Readonly<Record<keyof LeadSubmission, string>> = {
  name: "Sila masukkan nama anda (2 hingga 80 aksara).",
  phone: "Sila masukkan nombor telefon bimbit Malaysia yang sah, contohnya 012-345 6789.",
  desiredDate: "Sila pilih tarikh dari hari ini hingga 12 bulan akan datang.",
  usage: "Sila pilih tujuan penggunaan.",
  source: "Sila pilih dari mana anda mengetahui tentang kami.",
  consent: "Sila tandakan bahawa anda bersetuju dengan notis privasi.",
  turnstileToken: "Sila lengkapkan pengesahan keselamatan.",
};

/**
 * POST /api/leads — the public interest form.
 *
 * Order matters for cost and abuse: the free burst limiter first, then input validation,
 * then Turnstile (so bots without a valid token never cost a Firestore write), then the
 * per-IP and per-phone counters, then the write.
 */
export const createLeadHandler: Handler = async ({ request, url, services, logger }) => {
  const ip = clientIp(request) ?? "unknown";

  if (services.burstLimiter) {
    const { success } = await services.burstLimiter.limit({ key: `lead:${ip}` });
    if (!success) return rateLimitedResponse(60);
  }

  const body = await readJson(request);
  if (!body.ok) return body.response;

  const parsed = leadSubmissionSchema.safeParse(body.value);
  if (!parsed.success) {
    return validationErrorResponse(fieldErrors(parsed.error, LEAD_FIELD_MESSAGES));
  }
  const lead = parsed.data;

  const now = services.now();
  const today = mytDateString(now);
  if (
    lead.desiredDate !== null &&
    (lead.desiredDate < today || lead.desiredDate > addDays(today, MAX_DESIRED_DAYS_AHEAD))
  ) {
    return validationErrorResponse({ desiredDate: LEAD_FIELD_MESSAGES.desiredDate });
  }

  const human = await services.turnstile.verify({
    token: lead.turnstileToken,
    remoteIp: ip === "unknown" ? undefined : ip,
    expectedAction: "lead",
    expectedHostname: url.hostname,
  });
  if (!human) return errorResponse("TURNSTILE_FAILED");

  const [ipHash, phoneHash] = await Promise.all([
    services.hasher.hash("ip", ip),
    services.hasher.hash("phone", lead.phone),
  ]);
  for (const [rule, key] of [
    [RATE_LIMIT_RULES.leadPerIp, ipHash],
    [RATE_LIMIT_RULES.leadPerPhone, phoneHash],
  ] as const) {
    const limit = await hitRateLimit(services.db, rule, key, now);
    if (!limit.allowed) {
      logger.warn("lead.rate_limited", { rule: rule.name });
      return rateLimitedResponse(limit.retryAfterSeconds);
    }
  }

  const leadId = newDocumentId();
  await services.db.commit([
    createDoc(`leads/${leadId}`, {
      name: lead.name,
      phoneE164: lead.phone,
      phoneHash,
      desiredDate: lead.desiredDate,
      usage: lead.usage,
      source: lead.source,
      status: "new",
      notes: "",
      consent: { privacyVersion: DEFAULT_SETTINGS.policyVersions.privacy, at: now },
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }),
  ]);

  logger.info("lead.created", { leadId, usage: lead.usage, source: lead.source });
  return jsonResponse({ ok: true }, 201);
};
