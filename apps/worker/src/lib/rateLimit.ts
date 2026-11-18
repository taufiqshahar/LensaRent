/**
 * Business-level rate limits (docs/DECISIONS.md, ADR-007).
 *
 * Fixed-window counters in D1: one row per key per window, created or increased by a
 * single atomic upsert that returns the new count. Expired rows are deleted in the same
 * batch, using the expiry index, so the table stays small without a scheduled job.
 *
 * The Workers Rate Limiting binding (`RL_BURST`) only supports 10- or 60-second windows
 * and counts per Cloudflare location, so it is only a cheap first line against floods;
 * the limits that matter are these.
 */
export interface RateLimitRule {
  /** Names the limit, e.g. `lead-ip`. Part of the row key. */
  name: string;
  limit: number;
  windowSeconds: number;
}

export const RATE_LIMIT_RULES = {
  /** Interest form submissions from one IP. */
  leadPerIp: { name: "lead-ip", limit: 10, windowSeconds: 3600 },
  /** Interest form submissions for one phone number. */
  leadPerPhone: { name: "lead-phone", limit: 3, windowSeconds: 86_400 },
  /** Booking holds from one IP (master prompt §12: 5 per 10 minutes). */
  holdPerIp: { name: "hold-ip", limit: 5, windowSeconds: 600 },
  /** Booking holds for one phone number. */
  holdPerPhone: { name: "hold-phone", limit: 5, windowSeconds: 600 },
} as const satisfies Record<string, RateLimitRule>;

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the current window ends. */
  retryAfterSeconds: number;
}

const UPSERT = `INSERT INTO rate_limits (key, count, expires_at) VALUES (?, 1, ?)
  ON CONFLICT (key) DO UPDATE SET count = count + 1
  RETURNING count`;

/**
 * Counts one attempt for `key` under `rule`, and says whether it is within the limit.
 * `key` must already be a hash: identifiers are never stored readable.
 */
export async function hitRateLimit(
  db: D1Database,
  rule: RateLimitRule,
  key: string,
  now: Date,
): Promise<RateLimitResult> {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(key)) throw new Error("Rate limit key must be a hash");

  const windowMs = rule.windowSeconds * 1000;
  const window = Math.floor(now.getTime() / windowMs);
  const windowEndMs = (window + 1) * windowMs;

  const [, upsert] = await db.batch<{ count: number }>([
    db.prepare("DELETE FROM rate_limits WHERE expires_at <= ?").bind(now.toISOString()),
    db
      .prepare(UPSERT)
      .bind(`${rule.name}:${key}:${window.toString()}`, new Date(windowEndMs).toISOString()),
  ]);
  const count = upsert?.results[0]?.count;
  if (typeof count !== "number") throw new Error("Rate limit counter returned no value");

  return {
    allowed: count <= rule.limit,
    retryAfterSeconds: Math.max(1, Math.ceil((windowEndMs - now.getTime()) / 1000)),
  };
}
