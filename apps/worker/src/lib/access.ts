import type { JSONWebKeySet, JWTVerifyGetKey } from "jose";
import { createLocalJWKSet, jwtVerify } from "jose";
import { z } from "zod";

/**
 * Admin identity from Cloudflare Access (docs/DECISIONS.md, ADR-018).
 *
 * Cloudflare Access sits in front of /admin/* and /api/admin/*: it signs the admin in
 * (one-time PIN by email, or Google) and adds a signed JWT to every request it lets
 * through, in the `Cf-Access-Jwt-Assertion` header. The Worker does NOT trust that
 * Access is configured correctly: it verifies the JWT itself (signature against the team's
 * published keys, issuer, audience = the Access application's AUD tag, expiry) and then
 * checks the email against its own allowlist. A request that reaches the Worker without
 * a valid token — a misconfigured route, a workers.dev URL — is refused.
 */
export const ACCESS_JWT_HEADER = "cf-access-jwt-assertion";

const CLOCK_TOLERANCE_SECONDS = 30;
/** Cloudflare rotates its signing keys; refetch them at least this often. */
const KEYS_MAX_AGE_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5_000;

export interface AdminIdentity {
  /** Stable Access user id (`sub`). */
  id: string;
  email: string;
}

export interface AdminVerifier {
  /** The admin behind the request, or null when it is not a verified, allowed admin. */
  verify(request: Request): Promise<AdminIdentity | null>;
}

const claimsSchema = z.object({
  sub: z.string().min(1).max(256),
  email: z.string().min(3).max(320),
});

const jwksSchema = z.object({
  keys: z.array(z.looseObject({ kty: z.string() })).min(1),
});

/**
 * Keys are cached per isolate as plain values with their fetch time — never as a pending
 * promise shared between requests, which can hang a Worker (ADR-011).
 */
const keyCache = new Map<string, { keys: JSONWebKeySet; fetchedAt: number }>();

async function fetchKeys(certsUrl: string, fetcher: typeof fetch): Promise<JSONWebKeySet> {
  const response = await fetcher(certsUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Access certs request failed (HTTP ${response.status.toString()})`);
  }
  const parsed = jwksSchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) throw new Error("Access certs response was not understood");
  return parsed.data;
}

export interface AccessOptions {
  /** e.g. `lensarent.cloudflareaccess.com` */
  teamDomain: string;
  /** The Access application's AUD tag. */
  audience: string;
  /** Lower-case emails allowed in, as a second check behind the Access policy. */
  adminEmails: ReadonlySet<string>;
  /** Tests pass a local key set instead of fetching the team's certs. */
  keys?: JWTVerifyGetKey;
  fetch?: typeof fetch;
  now?: () => Date;
}

export function createAccessVerifier(options: AccessOptions): AdminVerifier {
  const fetcher = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? (() => new Date());
  const certsUrl = `https://${options.teamDomain}/cdn-cgi/access/certs`;

  const verifyWith = async (token: string, keys: JWTVerifyGetKey) => {
    const { payload } = await jwtVerify(token, keys, {
      algorithms: ["RS256"],
      issuer: `https://${options.teamDomain}`,
      audience: options.audience,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      currentDate: now(),
      requiredClaims: ["exp", "iat", "sub", "email"],
    });
    return payload;
  };

  const remoteKeys = async (refresh: boolean): Promise<JWTVerifyGetKey> => {
    const cached = keyCache.get(certsUrl);
    if (!refresh && cached && now().getTime() - cached.fetchedAt < KEYS_MAX_AGE_MS) {
      return createLocalJWKSet(cached.keys);
    }
    const keys = await fetchKeys(certsUrl, fetcher);
    keyCache.set(certsUrl, { keys, fetchedAt: now().getTime() });
    return createLocalJWKSet(keys);
  };

  return {
    async verify(request) {
      const token = request.headers.get(ACCESS_JWT_HEADER);
      if (!token) return null;

      let payload: unknown;
      try {
        if (options.keys) {
          payload = await verifyWith(token, options.keys);
        } else {
          try {
            payload = await verifyWith(token, await remoteKeys(false));
          } catch (error) {
            // A key we do not know yet means Cloudflare rotated keys: refetch once.
            if (!(error instanceof Error && error.name === "JWKSNoMatchingKey")) throw error;
            payload = await verifyWith(token, await remoteKeys(true));
          }
        }
      } catch {
        return null;
      }

      const claims = claimsSchema.safeParse(payload);
      if (!claims.success) return null;
      const email = claims.data.email.toLowerCase();
      if (!options.adminEmails.has(email)) return null;
      return { id: claims.data.sub, email };
    },
  };
}

/**
 * Local development and tests only (forbidden in staging/production by `loadConfig`):
 * every request is treated as coming from this admin, because there is no Access in front
 * of `wrangler dev`.
 */
export function createDevAdminVerifier(email: string): AdminVerifier {
  const identity = { id: `dev:${email}`, email };
  return { verify: () => Promise.resolve(identity) };
}

/** Test hook: forget cached keys. */
export function clearAccessKeyCache(): void {
  keyCache.clear();
}
