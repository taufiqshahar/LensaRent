import { Firestore } from "../src/lib/firestore";
import { EmulatorTokenProvider } from "../src/lib/googleAuth";

export const TEST_PROJECT_ID = "demo-lensarent";
export const EMULATOR_HOST = "127.0.0.1:8080";

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
    privateKeyPem: `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`,
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
