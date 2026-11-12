import { z } from "zod";
import type { AccessTokenProvider } from "./googleAuth";

/**
 * Firebase Authentication (Identity Toolkit) over REST.
 *
 * The Worker signs admins in on their behalf (docs/DECISIONS.md, ADR-013): the browser
 * sends email and password to the Worker, which calls `accounts:signInWithPassword`. That
 * keeps the API key off the browser, lets the Worker rate-limit attempts, and means the
 * browser only ever holds an HttpOnly session cookie.
 *
 * Endpoints and fields are from the official discovery document,
 * https://identitytoolkit.googleapis.com/$discovery/rest?version=v1
 *
 * The admin helpers (`lookupUserByEmail`, `setCustomClaims`) are used by
 * scripts/grant-admin.ts and by tests, never by a request handler. This file must only use
 * type-erasable TypeScript so Node can run that script directly.
 */
const PRODUCTION_ORIGIN = "https://identitytoolkit.googleapis.com";
const TIMEOUT_MS = 10_000;

export interface IdentityToolkitOptions {
  apiKey: string;
  /** `host:port` of the Auth emulator. Development and tests only. */
  emulatorHost?: string | undefined;
  fetch?: typeof fetch;
}

export type SignInResult =
  { ok: true; idToken: string; uid: string; email: string } | { ok: false; reason: SignInFailure };

export type SignInFailure =
  /** Wrong email or password, or no such account. Never tell the caller which. */
  | "INVALID_CREDENTIALS"
  | "USER_DISABLED"
  /** Firebase itself is throttling this account. */
  | "TOO_MANY_ATTEMPTS"
  /** The account has a second factor configured, which this flow does not support yet. */
  | "MFA_REQUIRED";

export class IdentityToolkitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityToolkitError";
  }
}

const signInResponseSchema = z.object({
  idToken: z.string().min(1).optional(),
  localId: z.string().min(1).optional(),
  email: z.string().optional(),
  mfaPendingCredential: z.string().optional(),
});

const errorResponseSchema = z.object({
  error: z.object({ message: z.string() }),
});

const CREDENTIAL_ERRORS = new Set([
  "INVALID_LOGIN_CREDENTIALS",
  "EMAIL_NOT_FOUND",
  "INVALID_PASSWORD",
  "INVALID_EMAIL",
  "MISSING_PASSWORD",
]);

function baseUrl(options: IdentityToolkitOptions): string {
  return options.emulatorHost
    ? `http://${options.emulatorHost}/identitytoolkit.googleapis.com`
    : PRODUCTION_ORIGIN;
}

async function post(
  options: IdentityToolkitOptions,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const fetcher = options.fetch ?? ((input, init) => fetch(input, init));
  const url = `${baseUrl(options)}/v1/${path}`;
  try {
    return await fetcher(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new IdentityToolkitError("Identity Toolkit request failed");
  }
}

/** Signs a user in with email and password. Credentials are never logged. */
export async function signInWithPassword(
  options: IdentityToolkitOptions,
  email: string,
  password: string,
): Promise<SignInResult> {
  const response = await post(
    options,
    `accounts:signInWithPassword?key=${encodeURIComponent(options.apiKey)}`,
    { email, password, returnSecureToken: true },
  );
  const payload: unknown = await response.json().catch(() => undefined);

  if (!response.ok) {
    const parsed = errorResponseSchema.safeParse(payload);
    // Messages can carry a suffix, e.g. "TOO_MANY_ATTEMPTS_TRY_LATER : Access ...".
    const code = parsed.success ? (parsed.data.error.message.split(" ")[0] ?? "") : "";
    if (response.status === 400 && CREDENTIAL_ERRORS.has(code)) {
      return { ok: false, reason: "INVALID_CREDENTIALS" };
    }
    if (code === "USER_DISABLED") return { ok: false, reason: "USER_DISABLED" };
    if (code.startsWith("TOO_MANY_ATTEMPTS")) return { ok: false, reason: "TOO_MANY_ATTEMPTS" };
    throw new IdentityToolkitError(
      `Sign-in request was rejected (HTTP ${response.status.toString()}${code ? ` ${code}` : ""})`,
    );
  }

  const parsed = signInResponseSchema.safeParse(payload);
  if (!parsed.success) throw new IdentityToolkitError("Sign-in response was not understood");
  if (parsed.data.mfaPendingCredential !== undefined) return { ok: false, reason: "MFA_REQUIRED" };
  const { idToken, localId, email: returnedEmail } = parsed.data;
  if (!idToken || !localId) throw new IdentityToolkitError("Sign-in response had no ID token");
  return { ok: true, idToken, uid: localId, email: returnedEmail ?? email };
}

// ── Admin operations (service account or emulator owner) ─────────────────────────────────

export interface AdminOptions extends IdentityToolkitOptions {
  projectId: string;
  tokenProvider: AccessTokenProvider;
}

export interface UserRecord {
  uid: string;
  email: string | undefined;
  disabled: boolean;
  customClaims: Record<string, unknown>;
}

const lookupResponseSchema = z.object({
  users: z
    .array(
      z.object({
        localId: z.string(),
        email: z.string().optional(),
        disabled: z.boolean().optional(),
        customAttributes: z.string().optional(),
      }),
    )
    .optional(),
});

async function adminPost(options: AdminOptions, method: string, body: unknown): Promise<unknown> {
  const token = await options.tokenProvider.getToken();
  const response = await post(
    options,
    `projects/${encodeURIComponent(options.projectId)}/accounts:${method}`,
    body,
    { authorization: `Bearer ${token}` },
  );
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const parsed = errorResponseSchema.safeParse(payload);
    throw new IdentityToolkitError(
      `accounts:${method} failed (HTTP ${response.status.toString()}${parsed.success ? ` ${parsed.data.error.message}` : ""})`,
    );
  }
  return payload;
}

export async function lookupUserByEmail(
  options: AdminOptions,
  email: string,
): Promise<UserRecord | null> {
  const parsed = lookupResponseSchema.parse(await adminPost(options, "lookup", { email: [email] }));
  const user = parsed.users?.[0];
  if (!user) return null;
  let customClaims: Record<string, unknown> = {};
  if (user.customAttributes) {
    const claims: unknown = JSON.parse(user.customAttributes);
    if (typeof claims === "object" && claims !== null)
      customClaims = claims as Record<string, unknown>;
  }
  return { uid: user.localId, email: user.email, disabled: user.disabled ?? false, customClaims };
}

/** Replaces the user's custom claims. They appear in ID tokens issued from now on. */
export async function setCustomClaims(
  options: AdminOptions,
  uid: string,
  claims: Record<string, unknown>,
): Promise<void> {
  await adminPost(options, "update", { localId: uid, customAttributes: JSON.stringify(claims) });
}
