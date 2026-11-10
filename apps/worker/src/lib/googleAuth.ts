import { z } from "zod";

/**
 * Google service-account authentication using Web Crypto only.
 *
 * `firebase-admin` cannot run on Workers (see docs/DECISIONS.md, ADR-001), so the Worker
 * signs a JWT with the service account's private key and exchanges it for a short-lived
 * OAuth2 access token. The same token works for the Firestore, Cloud Storage and Identity
 * Toolkit REST APIs, depending on the scopes requested.
 */
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const FIRESTORE_SCOPE = "https://www.googleapis.com/auth/datastore";

const JWT_LIFETIME_SECONDS = 3600;
/** Refresh this long before expiry so a token never expires mid-request. */
const REFRESH_MARGIN_MS = 60_000;
const TOKEN_REQUEST_TIMEOUT_MS = 10_000;

export interface AccessTokenProvider {
  getToken(): Promise<string>;
}

export interface ServiceAccount {
  clientEmail: string;
  privateKey: string;
  privateKeyId: string | undefined;
}

export class GoogleAuthError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GoogleAuthError";
  }
}

const serviceAccountSchema = z.object({
  client_email: z.email(),
  private_key: z.string().min(1),
  private_key_id: z.string().min(1).optional(),
});

/** Parses the service-account JSON secret. Errors never echo any part of the secret. */
export function parseServiceAccount(json: string): ServiceAccount {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new GoogleAuthError("Service account secret is not valid JSON");
  }
  const parsed = serviceAccountSchema.safeParse(raw);
  if (!parsed.success) {
    throw new GoogleAuthError("Service account secret is missing client_email or private_key");
  }
  return {
    clientEmail: parsed.data.client_email,
    privateKey: parsed.data.private_key,
    privateKeyId: parsed.data.private_key_id,
  };
}

function base64UrlEncode(input: string | ArrayBuffer): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  if (!pem.includes("-----BEGIN PRIVATE KEY-----")) {
    throw new GoogleAuthError("Service account private key must be a PKCS#8 PEM block");
  }
  try {
    const base64 = pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
    const der = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    return await crypto.subtle.importKey(
      "pkcs8",
      der,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch (cause) {
    throw new GoogleAuthError("Service account private key could not be imported", { cause });
  }
}

export interface JwtClaims {
  scope: string;
  aud: string;
  /** Issued-at, in seconds since the epoch. */
  iat: number;
  /** Expiry, in seconds since the epoch. */
  exp: number;
}

/** Signs an RS256 JWT as the service account. */
export async function signServiceAccountJwt(
  account: ServiceAccount,
  claims: JwtClaims,
): Promise<string> {
  const key = await importPrivateKey(account.privateKey);
  const header = {
    alg: "RS256",
    typ: "JWT",
    ...(account.privateKeyId && { kid: account.privateKeyId }),
  };
  const payload = { iss: account.clientEmail, ...claims };
  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

/**
 * Tokens are cached per isolate as plain values. Only finished values are shared between
 * requests — never promises, because awaiting another request's promise can hang a Worker.
 */
const tokenCache = new Map<string, CachedToken>();

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
});

export interface TokenProviderDeps {
  fetch?: typeof fetch;
  now?: () => number;
}

export class ServiceAccountTokenProvider implements AccessTokenProvider {
  readonly #account: ServiceAccount;
  readonly #scope: string;
  readonly #cacheKey: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  /** De-duplicates concurrent refreshes within this instance, i.e. within one request. */
  #refreshing: Promise<string> | undefined;

  constructor(account: ServiceAccount, scopes: readonly string[], deps: TokenProviderDeps = {}) {
    this.#account = account;
    this.#scope = scopes.join(" ");
    this.#cacheKey = `${account.clientEmail}|${account.privateKeyId ?? ""}|${this.#scope}`;
    this.#fetch = deps.fetch ?? ((input, init) => fetch(input, init));
    this.#now = deps.now ?? (() => Date.now());
  }

  async getToken(): Promise<string> {
    const cached = tokenCache.get(this.#cacheKey);
    if (cached && cached.expiresAtMs - REFRESH_MARGIN_MS > this.#now()) return cached.token;

    this.#refreshing ??= this.#refresh().finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }

  async #refresh(): Promise<string> {
    const issuedAt = Math.floor(this.#now() / 1000);
    const assertion = await signServiceAccountJwt(this.#account, {
      scope: this.#scope,
      aud: GOOGLE_TOKEN_URL,
      iat: issuedAt,
      exp: issuedAt + JWT_LIFETIME_SECONDS,
    });

    let response: Response;
    try {
      response = await this.#fetch(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion,
        }).toString(),
        signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      throw new GoogleAuthError("Google token request failed", { cause });
    }

    if (!response.ok) {
      // The body can describe the key or account, so only the status is reported.
      await response.body?.cancel();
      throw new GoogleAuthError(
        `Google token request was rejected (HTTP ${response.status.toString()})`,
      );
    }

    const parsed = tokenResponseSchema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) throw new GoogleAuthError("Google token response was not understood");

    tokenCache.set(this.#cacheKey, {
      token: parsed.data.access_token,
      expiresAtMs: this.#now() + parsed.data.expires_in * 1000,
    });
    return parsed.data.access_token;
  }
}

/** The Firebase emulators accept the literal token "owner" as an admin caller. */
export class EmulatorTokenProvider implements AccessTokenProvider {
  getToken(): Promise<string> {
    return Promise.resolve("owner");
  }
}

/** Test hook: forget every cached token. */
export function clearTokenCache(): void {
  tokenCache.clear();
}
