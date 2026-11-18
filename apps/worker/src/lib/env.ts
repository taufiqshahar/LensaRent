import { z } from "zod";

export const ENVIRONMENTS = ["development", "test", "staging", "production"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

/** Bindings exactly as Cloudflare hands them over. Untrusted until `loadConfig` parses them. */
export interface Env {
  ENVIRONMENT?: string;
  /** Secret: Cloudflare Turnstile secret key. */
  TURNSTILE_SECRET_KEY?: string;
  /** Secret: pepper for the HMAC of phone numbers and IP addresses. */
  PHONE_HASH_PEPPER?: string;
  /** Cloudflare Access team domain, e.g. `lensarent.cloudflareaccess.com`. */
  ACCESS_TEAM_DOMAIN?: string;
  /** The AUD tag of the Access application that protects /admin and /api/admin. */
  ACCESS_AUD?: string;
  /** Comma-separated admin emails, checked again in the Worker behind the Access policy. */
  ADMIN_EMAILS?: string;
  /** Local development and tests only: act as this admin without Access. */
  ACCESS_DEV_EMAIL?: string;
  /** Secret: CHIP Collect API key. Without it (and CHIP_BRAND_ID) online booking is closed. */
  CHIP_SECRET_KEY?: string;
  /** CHIP brand id (not secret). */
  CHIP_BRAND_ID?: string;
  /** Optional pinned CHIP public key (PEM) for callback signatures; else fetched from CHIP. */
  CHIP_PUBLIC_KEY?: string;
  /** Public origin of the site, e.g. `https://lensarent.my`. Used in emails (no request there). */
  SITE_ORIGIN?: string;
  /** Secret: Resend API key. Without it (and EMAIL_FROM) queued emails wait unsent. */
  RESEND_API_KEY?: string;
  /** Sender, e.g. `LensaRent <tempahan@lensarent.my>`, on a domain verified in Resend. */
  EMAIL_FROM?: string;
  DB?: D1Database;
  ASSETS?: Fetcher;
  /** Workers Rate Limiting binding: a cheap first line against bursts from one IP. */
  RL_BURST?: RateLimit;
}

export type AdminAuthConfig =
  | { mode: "access"; teamDomain: string; audience: string; adminEmails: ReadonlySet<string> }
  | { mode: "dev"; email: string };

export interface ChipConfig {
  secretKey: string;
  brandId: string;
  publicKeyPem: string | undefined;
}

export interface EmailConfig {
  resendApiKey: string;
  from: string;
}

export interface AppConfig {
  environment: Environment;
  /** Staging and production: strict checks apply (Turnstile hostname/action, no dev login). */
  deployed: boolean;
  turnstileSecretKey: string;
  phoneHashPepper: string;
  adminAuth: AdminAuthConfig;
  /** Absent: online booking is closed (the site still works; leads still work). */
  chip: ChipConfig | undefined;
  /** Absent: emails stay queued in the outbox until it is configured. */
  email: EmailConfig | undefined;
  /** For links in emails. Absent: emails carry the reference code but no link. */
  siteOrigin: string | undefined;
  /** Where operational alerts (payment mismatch, overdue) are emailed. */
  alertEmails: readonly string[];
}

export class ConfigError extends Error {
  constructor(problems: readonly string[]) {
    super(`Invalid Worker configuration: ${problems.join("; ")}`);
    this.name = "ConfigError";
  }
}

/** Unset and empty bindings are treated the same. */
const optionalText = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().optional(),
);

const emailList = optionalText.transform((value, context) => {
  if (value === undefined) return undefined;
  const emails = value
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email !== "");
  if (emails.length === 0 || !emails.every((email) => z.email().safeParse(email).success)) {
    context.addIssue({ code: "custom", message: "must be a comma-separated list of emails" });
    return z.NEVER;
  }
  return new Set(emails);
});

const configSchema = z
  .object({
    ENVIRONMENT: z.enum(ENVIRONMENTS),
    TURNSTILE_SECRET_KEY: z.string().min(1, "is required"),
    PHONE_HASH_PEPPER: z.string().min(32, "must be at least 32 characters"),
    ACCESS_TEAM_DOMAIN: optionalText.refine(
      (value) => value === undefined || /^[a-z0-9-]{1,63}\.cloudflareaccess\.com$/.test(value),
      "must look like <team>.cloudflareaccess.com",
    ),
    ACCESS_AUD: optionalText.refine(
      (value) => value === undefined || /^[a-f0-9]{32,128}$/.test(value),
      "must be the Access application's AUD tag",
    ),
    ADMIN_EMAILS: emailList,
    ACCESS_DEV_EMAIL: optionalText.refine(
      (value) => value === undefined || z.email().safeParse(value).success,
      "must be an email",
    ),
    SITE_ORIGIN: optionalText.refine(
      (value) => value === undefined || /^https?:\/\/[a-z0-9.-]+(:\d+)?$/.test(value),
      "must be an origin like https://example.com (no path, no trailing slash)",
    ),
    RESEND_API_KEY: optionalText,
    EMAIL_FROM: optionalText.refine(
      (value) =>
        value === undefined ||
        /^[^<>\r\n]{0,80}<[^\s<>@]+@[^\s<>@]+>$|^[^\s<>@]+@[^\s<>@]+$/.test(value),
      "must be an email, or a name followed by <email>",
    ),
    CHIP_SECRET_KEY: optionalText,
    CHIP_BRAND_ID: optionalText.refine(
      (value) => value === undefined || /^[A-Za-z0-9-]{1,100}$/.test(value),
      "must be a CHIP brand id",
    ),
    CHIP_PUBLIC_KEY: optionalText.refine(
      (value) => value === undefined || value.includes("PUBLIC KEY"),
      "must be a PEM public key",
    ),
  })
  .superRefine((value, context) => {
    const deployed = value.ENVIRONMENT === "staging" || value.ENVIRONMENT === "production";
    const issue = (path: string, message: string) => {
      context.addIssue({ code: "custom", path: [path], message });
    };
    if (deployed && value.ACCESS_DEV_EMAIL !== undefined) {
      issue("ACCESS_DEV_EMAIL", "must not be set in a deployed environment");
    }
    if (deployed || value.ACCESS_DEV_EMAIL === undefined) {
      if (value.ACCESS_TEAM_DOMAIN === undefined) issue("ACCESS_TEAM_DOMAIN", "is required");
      if (value.ACCESS_AUD === undefined) issue("ACCESS_AUD", "is required");
      if (value.ADMIN_EMAILS === undefined) issue("ADMIN_EMAILS", "is required");
    }
    if ((value.RESEND_API_KEY === undefined) !== (value.EMAIL_FROM === undefined)) {
      issue("EMAIL_FROM", "RESEND_API_KEY and EMAIL_FROM must be set together");
    }
    if ((value.CHIP_SECRET_KEY === undefined) !== (value.CHIP_BRAND_ID === undefined)) {
      issue("CHIP_BRAND_ID", "CHIP_SECRET_KEY and CHIP_BRAND_ID must be set together");
    }
  });

/**
 * Validates the Worker's bindings. Problems name the binding only, never its value, so a
 * misconfigured secret cannot end up in a log line.
 */
export function loadConfig(env: Env): AppConfig {
  const parsed = configSchema.safeParse({
    ENVIRONMENT: env.ENVIRONMENT,
    TURNSTILE_SECRET_KEY: env.TURNSTILE_SECRET_KEY,
    PHONE_HASH_PEPPER: env.PHONE_HASH_PEPPER,
    ACCESS_TEAM_DOMAIN: env.ACCESS_TEAM_DOMAIN,
    ACCESS_AUD: env.ACCESS_AUD,
    ADMIN_EMAILS: env.ADMIN_EMAILS,
    ACCESS_DEV_EMAIL: env.ACCESS_DEV_EMAIL,
    SITE_ORIGIN: env.SITE_ORIGIN,
    RESEND_API_KEY: env.RESEND_API_KEY,
    EMAIL_FROM: env.EMAIL_FROM,
    CHIP_SECRET_KEY: env.CHIP_SECRET_KEY,
    CHIP_BRAND_ID: env.CHIP_BRAND_ID,
    CHIP_PUBLIC_KEY: env.CHIP_PUBLIC_KEY,
  });
  const problems = parsed.success
    ? []
    : parsed.error.issues.map((issue) => {
        const binding = issue.path.join(".");
        // zod's message for a missing value mentions the received type, never the value.
        return issue.code === "invalid_type"
          ? `${binding} is required`
          : `${binding} ${issue.message}`;
      });
  if (!env.DB) problems.push("DB (D1 binding) is required");
  if (!parsed.success || problems.length > 0) throw new ConfigError(problems);

  const data = parsed.data;
  const deployed = data.ENVIRONMENT === "staging" || data.ENVIRONMENT === "production";
  const adminAuth: AdminAuthConfig =
    !deployed && data.ACCESS_DEV_EMAIL !== undefined
      ? { mode: "dev", email: data.ACCESS_DEV_EMAIL.toLowerCase() }
      : {
          mode: "access",
          // Checked by superRefine above.
          teamDomain: data.ACCESS_TEAM_DOMAIN ?? "",
          audience: data.ACCESS_AUD ?? "",
          adminEmails: data.ADMIN_EMAILS ?? new Set<string>(),
        };
  return {
    environment: data.ENVIRONMENT,
    deployed,
    turnstileSecretKey: data.TURNSTILE_SECRET_KEY,
    phoneHashPepper: data.PHONE_HASH_PEPPER,
    adminAuth,
    chip:
      data.CHIP_SECRET_KEY !== undefined && data.CHIP_BRAND_ID !== undefined
        ? {
            secretKey: data.CHIP_SECRET_KEY,
            brandId: data.CHIP_BRAND_ID,
            publicKeyPem: data.CHIP_PUBLIC_KEY,
          }
        : undefined,
    email:
      data.RESEND_API_KEY !== undefined && data.EMAIL_FROM !== undefined
        ? { resendApiKey: data.RESEND_API_KEY, from: data.EMAIL_FROM }
        : undefined,
    siteOrigin: data.SITE_ORIGIN,
    alertEmails: adminAuth.mode === "dev" ? [adminAuth.email] : [...adminAuth.adminEmails],
  };
}
