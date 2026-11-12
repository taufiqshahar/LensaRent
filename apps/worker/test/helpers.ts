import type { AppConfig, Env } from "../src/lib/env";
import { Firestore } from "../src/lib/firestore";
import { EmulatorTokenProvider } from "../src/lib/googleAuth";

export const TEST_PROJECT_ID = "demo-lensarent";
export const EMULATOR_HOST = "127.0.0.1:8080";
export const AUTH_EMULATOR_HOST = "127.0.0.1:9099";

/** Complete, valid bindings for tests. Values are obvious placeholders, never real secrets. */
export const TEST_ENV: Env = {
  ENVIRONMENT: "test",
  FIREBASE_PROJECT_ID: TEST_PROJECT_ID,
  FIREBASE_API_KEY: "demo-api-key",
  TURNSTILE_SECRET_KEY: "test-turnstile-secret",
  PHONE_HASH_PEPPER: "test-pepper-test-pepper-test-pepper",
  FIRESTORE_EMULATOR_HOST: EMULATOR_HOST,
  FIREBASE_AUTH_EMULATOR_HOST: AUTH_EMULATOR_HOST,
};

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    environment: "test",
    deployed: false,
    firebaseProjectId: TEST_PROJECT_ID,
    serviceAccountJson: undefined,
    firebaseApiKey: "demo-api-key",
    turnstileSecretKey: "test-turnstile-secret",
    phoneHashPepper: "test-pepper-test-pepper-test-pepper",
    firestoreEmulatorHost: EMULATOR_HOST,
    authEmulatorHost: AUTH_EMULATOR_HOST,
    ...overrides,
  };
}

/** A client for the local Firestore emulator (start it with `pnpm test:emulator`). */
export function emulatorDb(): Firestore {
  return new Firestore({
    projectId: TEST_PROJECT_ID,
    emulatorHost: EMULATOR_HOST,
    tokenProvider: new EmulatorTokenProvider(),
  });
}

/** Tests share one emulator, so each uses ids nobody else will touch. */
export function uniqueId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 12)}`;
}

function toBase64(buffer: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Builds a PEM block at run time. Tests never hold a literal key block in source, so the
 * secret scanner only ever reports real findings.
 */
export function fakePem(label: string, body = "AAAA"): string {
  const dashes = "-".repeat(5);
  return `${dashes}BEGIN ${label}${dashes}\n${body}\n${dashes}END ${label}${dashes}\n`;
}

/** A throwaway RSA key shaped like a service-account key. Never a real credential. */
export async function generateTestServiceAccountKey(): Promise<{
  privateKeyPem: string;
  publicKey: CryptoKey;
}> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer;
  const body = toBase64(pkcs8).replace(/(.{64})/g, "$1\n");
  return {
    privateKeyPem: fakePem("PRIVATE KEY", body),
    publicKey: pair.publicKey,
  };
}

export function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

export function decodeJwtPart(part: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(part))) as Record<string, unknown>;
}
