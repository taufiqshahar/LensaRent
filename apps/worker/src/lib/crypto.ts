/**
 * Small Web Crypto helpers. Nothing here needs a library.
 */
const encoder = new TextEncoder();

export function base64UrlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** `byteLength` cryptographically random bytes, base64url-encoded. */
export function randomToken(byteLength = 32): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function sha256(value: string): Promise<string> {
  return base64UrlEncode(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

/**
 * Keyed hash for personal identifiers (phone numbers, IP addresses) so they can be matched
 * and rate-limited without being readable. `purpose` separates the uses: the same phone
 * number hashed for two purposes gives two unrelated values.
 */
export interface Hasher {
  hash(purpose: "phone" | "ip" | "email", value: string): Promise<string>;
}

export function createHasher(pepper: string): Hasher {
  let key: Promise<CryptoKey> | undefined;
  return {
    async hash(purpose, value) {
      key ??= crypto.subtle.importKey(
        "raw",
        encoder.encode(pepper),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const signature = await crypto.subtle.sign(
        "HMAC",
        await key,
        encoder.encode(`${purpose}:${value}`),
      );
      return base64UrlEncode(signature);
    },
  };
}
