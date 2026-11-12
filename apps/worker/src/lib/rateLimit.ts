import type { Firestore } from "./firestore";
import { increment, upsertDoc } from "./firestore";

/**
 * Business-level rate limits (docs/DECISIONS.md, ADR-007).
 *
 * Fixed-window counters in Firestore: one document per key per window, increased with an
 * atomic server-side increment. The commit returns the new count, so a check costs one
 * round trip and one write. Documents carry `expiresAt` for a Firestore TTL policy.
 *
 * The Workers Rate Limiting binding (`RL_BURST`) only supports 10- or 60-second windows
 * and counts per Cloudflare location, so it is used only as a cheap first line against
 * floods; the limits that matter are these.
 */
export const RATE_LIMITS_COLLECTION = "rateLimits";

export interface RateLimitRule {
  /** Names the limit, e.g. `lead-ip`. Part of the document id. */
  name: string;
  limit: number;
  windowSeconds: number;
}

export const RATE_LIMIT_RULES = {
  /** Interest form submissions from one IP. */
  leadPerIp: { name: "lead-ip", limit: 10, windowSeconds: 3600 },
  /** Interest form submissions for one phone number. */
  leadPerPhone: { name: "lead-phone", limit: 3, windowSeconds: 86_400 },
  /** Admin sign-in attempts from one IP. */
  loginPerIp: { name: "login-ip", limit: 10, windowSeconds: 900 },
  /** Admin sign-in attempts for one email address. */
  loginPerEmail: { name: "login-email", limit: 5, windowSeconds: 900 },
} as const satisfies Record<string, RateLimitRule>;

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the current window ends. */
  retryAfterSeconds: number;
}

/**
 * Counts one attempt for `key` under `rule`, and says whether it is within the limit.
 * `key` must already be a hash: it becomes part of a document id.
 */
export async function hitRateLimit(
  db: Firestore,
  rule: RateLimitRule,
  key: string,
  now: Date,
): Promise<RateLimitResult> {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(key)) throw new Error("Rate limit key must be a hash");

  const windowMs = rule.windowSeconds * 1000;
  const window = Math.floor(now.getTime() / windowMs);
  const windowEndMs = (window + 1) * windowMs;

  const [result] = await db.commit([
    upsertDoc(`${RATE_LIMITS_COLLECTION}/${rule.name}_${key}_${window.toString()}`, {
      count: increment(1),
      expiresAt: new Date(windowEndMs),
    }),
  ]);
  const count = result?.transformResults[0];
  if (typeof count !== "number") throw new Error("Rate limit counter returned no value");

  return {
    allowed: count <= rule.limit,
    retryAfterSeconds: Math.max(1, Math.ceil((windowEndMs - now.getTime()) / 1000)),
  };
}
