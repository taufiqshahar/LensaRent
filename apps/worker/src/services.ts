import type { AdminVerifier } from "./lib/access";
import { createAccessVerifier, createDevAdminVerifier } from "./lib/access";
import type { Hasher } from "./lib/crypto";
import { createHasher } from "./lib/crypto";
import type { AppConfig, Env } from "./lib/env";
import { ConfigError } from "./lib/env";
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
  now(): Date;
}

export function createServices(config: AppConfig, env: Env): Services {
  if (!env.DB) throw new ConfigError(["DB (D1 binding) is required"]);
  const auth = config.adminAuth;
  return {
    db: env.DB,
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
    now: () => new Date(),
  };
}

export type ServicesFactory = (config: AppConfig, env: Env) => Services;
