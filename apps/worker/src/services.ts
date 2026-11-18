import type { AdminVerifier } from "./lib/access";
import { createAccessVerifier, createDevAdminVerifier } from "./lib/access";
import type { Hasher } from "./lib/crypto";
import { createHasher } from "./lib/crypto";
import type { AllSettings } from "@lensarent/shared";
import type { PaymentProvider } from "./lib/chip";
import { createChipProvider } from "./lib/chip";
import type { AppConfig, Env } from "./lib/env";
import { ConfigError } from "./lib/env";
import type { Mailer } from "./lib/resend";
import { createResendMailer } from "./lib/resend";
import { loadSettings } from "./lib/settings";
import type { TurnstileVerifier } from "./lib/turnstile";
import { createTurnstileVerifier } from "./lib/turnstile";

/**
 * Everything a handler talks to outside its own code. Built once per request from
 * validated configuration; tests replace individual services (e.g. Turnstile) and keep
 * the rest real.
 */
export interface Services {
  db: D1Database;
  turnstile: TurnstileVerifier;
  hasher: Hasher;
  admins: AdminVerifier;
  /** Optional first line against floods; the real limits are in D1. */
  burstLimiter: RateLimit | undefined;
  /** Absent when CHIP is not configured: online booking is closed. */
  payments: PaymentProvider | undefined;
  /** Absent when Resend is not configured: emails wait in the outbox. */
  mailer: Mailer | undefined;
  /** Effective settings: code defaults plus the admin-edited keys (ADR-020). */
  settings(): Promise<AllSettings>;
  now(): Date;
}

export function createServices(config: AppConfig, env: Env): Services {
  const db = env.DB;
  if (!db) throw new ConfigError(["DB (D1 binding) is required"]);
  const auth = config.adminAuth;
  let settings: Promise<AllSettings> | undefined;
  return {
    db,
    turnstile: createTurnstileVerifier({
      secretKey: config.turnstileSecretKey,
      strict: config.deployed,
    }),
    hasher: createHasher(config.phoneHashPepper),
    admins:
      auth.mode === "dev"
        ? createDevAdminVerifier(auth.email)
        : createAccessVerifier({
            teamDomain: auth.teamDomain,
            audience: auth.audience,
            adminEmails: auth.adminEmails,
          }),
    burstLimiter: env.RL_BURST,
    payments: config.chip ? createChipProvider(config.chip) : undefined,
    mailer: config.email
      ? createResendMailer({ apiKey: config.email.resendApiKey, from: config.email.from })
      : undefined,
    // Loaded at most once per request.
    settings: () => (settings ??= loadSettings(db)),
    now: () => new Date(),
  };
}

export type ServicesFactory = (config: AppConfig, env: Env) => Services;
