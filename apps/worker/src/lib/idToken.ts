import type { JWTPayload, JWTVerifyGetKey } from "jose";
import { createRemoteJWKSet, decodeJwt, jwtVerify } from "jose";
import { z } from "zod";

/**
 * Verifies Firebase ID tokens and extracts the admin identity.
 *
 * Production: RS256 signature against Google's published keys, plus issuer, audience and
 * expiry, using `jose` (well-tested, zero dependencies, Web Crypto based).
 *
 * Emulator: the Auth emulator issues UNSIGNED tokens, so only the claims are checked.
 * This path exists only when an emulator host is configured, which `loadConfig` forbids in
 * staging and production.
 */
export const SECURETOKEN_JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

/** Tolerated clock difference between Google and Cloudflare. */
const CLOCK_TOLERANCE_SECONDS = 30;

export interface AdminIdentity {
  uid: string;
  email: string;
}

export interface IdTokenVerifier {
  /** Returns the admin behind the token, or null if the token is invalid or not an admin. */
  verifyAdmin(idToken: string): Promise<AdminIdentity | null>;
}

const claimsSchema = z.object({
  sub: z.string().min(1).max(128),
  email: z.string().min(3).max(320),
  auth_time: z.number().int(),
  admin: z.literal(true),
});

function adminFrom(payload: JWTPayload, nowSeconds: number): AdminIdentity | null {
  const parsed = claimsSchema.safeParse(payload);
  if (!parsed.success) return null;
  // A sign-in cannot happen in the future.
  if (parsed.data.auth_time > nowSeconds + CLOCK_TOLERANCE_SECONDS) return null;
  return { uid: parsed.data.sub, email: parsed.data.email };
}

export interface VerifierOptions {
  projectId: string;
  /** Key source; defaults to Google's JWKS. Tests pass a local key set. */
  keys?: JWTVerifyGetKey;
  now?: () => Date;
}

export function createIdTokenVerifier(options: VerifierOptions): IdTokenVerifier {
  const now = options.now ?? (() => new Date());
  // Created per verifier, i.e. per request: sign-ins are rare, and sharing a fetch promise
  // across requests can hang a Worker.
  const keys = options.keys ?? createRemoteJWKSet(new URL(SECURETOKEN_JWKS_URL));
  return {
    async verifyAdmin(idToken) {
      try {
        const { payload } = await jwtVerify(idToken, keys, {
          algorithms: ["RS256"],
          issuer: `https://securetoken.google.com/${options.projectId}`,
          audience: options.projectId,
          clockTolerance: CLOCK_TOLERANCE_SECONDS,
          currentDate: now(),
          requiredClaims: ["sub", "iat", "exp", "auth_time"],
        });
        return adminFrom(payload, Math.floor(now().getTime() / 1000));
      } catch {
        return null;
      }
    },
  };
}

/** Claims-only check for the Auth emulator's unsigned tokens. Never used once deployed. */
export function createEmulatorIdTokenVerifier(options: VerifierOptions): IdTokenVerifier {
  const now = options.now ?? (() => new Date());
  return {
    verifyAdmin(idToken) {
      try {
        const payload = decodeJwt(idToken);
        const nowSeconds = Math.floor(now().getTime() / 1000);
        const valid =
          payload.iss === `https://securetoken.google.com/${options.projectId}` &&
          payload.aud === options.projectId &&
          typeof payload.exp === "number" &&
          payload.exp > nowSeconds - CLOCK_TOLERANCE_SECONDS;
        return Promise.resolve(valid ? adminFrom(payload, nowSeconds) : null);
      } catch {
        return Promise.resolve(null);
      }
    },
  };
}
