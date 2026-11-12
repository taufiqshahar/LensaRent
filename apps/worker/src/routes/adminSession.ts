import { z } from "zod";
import { auditWrite } from "../lib/audit";
import {
  clientIp,
  errorResponse,
  isSameOrigin,
  jsonResponse,
  rateLimitedResponse,
  readJson,
} from "../lib/http";
import { RATE_LIMIT_RULES, hitRateLimit } from "../lib/rateLimit";
import { clearedSessionCookie, endSessionWrite, newSession, sessionCookie } from "../lib/sessions";
import type { Handler } from "../router";
import { requireAdmin } from "./adminAuth";

const loginSchema = z.strictObject({
  email: z.string().trim().toLowerCase().max(320),
  password: z.string().min(1).max(256),
});

/**
 * POST /api/admin/session — sign in.
 *
 * Every failure gives the same answer ("wrong email or password"), whether the account
 * does not exist, the password is wrong, the account is disabled or it is not an admin.
 * The reason goes to the log, without the email address.
 */
export const loginHandler: Handler = async ({ request, url, services, logger }) => {
  if (!isSameOrigin(request, url)) return errorResponse("FORBIDDEN_ORIGIN");
  const ip = clientIp(request) ?? "unknown";

  if (services.burstLimiter) {
    const { success } = await services.burstLimiter.limit({ key: `login:${ip}` });
    if (!success) return rateLimitedResponse(60);
  }

  const body = await readJson(request);
  if (!body.ok) return body.response;
  const parsed = loginSchema.safeParse(body.value);
  if (!parsed.success) return errorResponse("LOGIN_FAILED");
  const { email, password } = parsed.data;

  const now = services.now();
  const [ipHash, emailHash] = await Promise.all([
    services.hasher.hash("ip", ip),
    services.hasher.hash("email", email),
  ]);
  for (const [rule, key] of [
    [RATE_LIMIT_RULES.loginPerIp, ipHash],
    [RATE_LIMIT_RULES.loginPerEmail, emailHash],
  ] as const) {
    const limit = await hitRateLimit(services.db, rule, key, now);
    if (!limit.allowed) {
      logger.warn("admin.login_rate_limited", { rule: rule.name });
      return rateLimitedResponse(limit.retryAfterSeconds);
    }
  }

  const result = await services.signIn(email, password);
  if (!result.ok) {
    logger.warn("admin.login_failed", { reason: result.reason });
    return errorResponse("LOGIN_FAILED");
  }

  const admin = await services.idTokens.verifyAdmin(result.idToken);
  if (!admin || admin.uid !== result.uid) {
    logger.warn("admin.login_failed", { reason: admin ? "UID_MISMATCH" : "NOT_ADMIN" });
    return errorResponse("LOGIN_FAILED");
  }

  const { token, session, write } = await newSession(admin, ipHash, now);
  await services.db.commit([
    write,
    auditWrite({
      actorId: admin.uid,
      action: "admin.login",
      targetCollection: "adminSessions",
      targetId: session.id,
    }),
  ]);
  logger.info("admin.login", { actorId: admin.uid });

  return jsonResponse({ email: session.email, expiresAt: session.expiresAt.toISOString() }, 200, {
    "Set-Cookie": sessionCookie(token),
  });
};

/** GET /api/admin/session — who is signed in. */
export const currentSessionHandler: Handler = async (context) => {
  const auth = await requireAdmin(context, { mutating: false });
  if ("response" in auth) return auth.response;
  return jsonResponse({
    email: auth.session.email,
    expiresAt: auth.session.expiresAt.toISOString(),
    idleExpiresAt: auth.session.idleExpiresAt.toISOString(),
  });
};

/** DELETE /api/admin/session — sign out. */
export const logoutHandler: Handler = async (context) => {
  const auth = await requireAdmin(context, { mutating: true });
  if ("response" in auth) return auth.response;
  const { session } = auth;
  await context.services.db.commit([
    endSessionWrite(session.id),
    auditWrite({
      actorId: session.uid,
      action: "admin.logout",
      targetCollection: "adminSessions",
      targetId: session.id,
    }),
  ]);
  return new Response(null, {
    status: 204,
    headers: { "Set-Cookie": clearedSessionCookie(), "Cache-Control": "no-store" },
  });
};
