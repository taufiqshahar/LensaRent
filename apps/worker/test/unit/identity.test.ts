import type { JWTPayload } from "jose";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, UnsecuredJWT } from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createEmulatorIdTokenVerifier, createIdTokenVerifier } from "../../src/lib/idToken";
import { IdentityToolkitError, signInWithPassword } from "../../src/lib/identityToolkit";

const PROJECT = "lensarent-production";
const NOW = new Date("2026-12-24T12:00:00.000Z");
const nowSeconds = Math.floor(NOW.getTime() / 1000);

let privateKey: CryptoKey;
let otherKey: CryptoKey;
let keys: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  const other = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  otherKey = other.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256" };
  keys = createLocalJWKSet({ keys: [jwk] });
});

const goodClaims: JWTPayload = {
  iss: `https://securetoken.google.com/${PROJECT}`,
  aud: PROJECT,
  sub: "uid-admin",
  email: "admin@example.com",
  auth_time: nowSeconds - 60,
  iat: nowSeconds - 60,
  exp: nowSeconds + 3540,
  admin: true,
};

function sign(claims: JWTPayload, key = privateKey, kid = "k1"): Promise<string> {
  return new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid }).sign(key);
}

describe("createIdTokenVerifier", () => {
  const verifier = () => createIdTokenVerifier({ projectId: PROJECT, keys, now: () => NOW });

  it("accepts a valid admin token", async () => {
    await expect(verifier().verifyAdmin(await sign(goodClaims))).resolves.toEqual({
      uid: "uid-admin",
      email: "admin@example.com",
    });
  });

  it.each([
    ["no admin claim", { admin: undefined }],
    ["an admin claim that is not true", { admin: "true" }],
    ["another project as audience", { aud: "someone-else" }],
    ["another issuer", { iss: "https://securetoken.google.com/someone-else" }],
    ["an expired token", { exp: nowSeconds - 120 }],
    ["a sign-in in the future", { auth_time: nowSeconds + 3600 }],
    ["no subject", { sub: undefined }],
    ["no email", { email: undefined }],
  ])("refuses %s", async (_label, override) => {
    await expect(
      verifier().verifyAdmin(await sign({ ...goodClaims, ...override })),
    ).resolves.toBeNull();
  });

  it("refuses a token signed by another key", async () => {
    await expect(verifier().verifyAdmin(await sign(goodClaims, otherKey))).resolves.toBeNull();
  });

  it("refuses an unsigned token and garbage", async () => {
    const unsigned = new UnsecuredJWT(goodClaims).encode();
    await expect(verifier().verifyAdmin(unsigned)).resolves.toBeNull();
    await expect(verifier().verifyAdmin("not-a-jwt")).resolves.toBeNull();
  });
});

describe("createEmulatorIdTokenVerifier", () => {
  const verifier = createEmulatorIdTokenVerifier({ projectId: PROJECT, now: () => NOW });

  it("checks the claims of the emulator's unsigned tokens", async () => {
    await expect(verifier.verifyAdmin(new UnsecuredJWT(goodClaims).encode())).resolves.toEqual({
      uid: "uid-admin",
      email: "admin@example.com",
    });
    for (const override of [
      { aud: "x" },
      { iss: "x" },
      { exp: nowSeconds - 120 },
      { admin: false },
    ]) {
      await expect(
        verifier.verifyAdmin(new UnsecuredJWT({ ...goodClaims, ...override }).encode()),
      ).resolves.toBeNull();
    }
    await expect(verifier.verifyAdmin("garbage")).resolves.toBeNull();
  });
});

describe("signInWithPassword", () => {
  const respond = (body: unknown, status = 200) =>
    vi.fn<typeof fetch>(() => Promise.resolve(Response.json(body, { status })));

  it("calls the production endpoint with the API key and returns the ID token", async () => {
    const fetchMock = respond({ idToken: "tok", localId: "uid-1", email: "a@example.com" });
    await expect(
      signInWithPassword({ apiKey: "k&y", fetch: fetchMock }, "a@example.com", "pw"),
    ).resolves.toEqual({ ok: true, idToken: "tok", uid: "uid-1", email: "a@example.com" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=k%26y",
    );
    expect(JSON.parse(init?.body as string)).toEqual({
      email: "a@example.com",
      password: "pw",
      returnSecureToken: true,
    });
  });

  it("uses the emulator when configured", async () => {
    const fetchMock = respond({ idToken: "tok", localId: "uid-1" });
    await signInWithPassword(
      { apiKey: "k", emulatorHost: "127.0.0.1:9099", fetch: fetchMock },
      "a@b.co",
      "pw",
    );
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=k",
    );
  });

  it.each([
    ["INVALID_LOGIN_CREDENTIALS", 400, "INVALID_CREDENTIALS"],
    ["EMAIL_NOT_FOUND", 400, "INVALID_CREDENTIALS"],
    ["INVALID_PASSWORD", 400, "INVALID_CREDENTIALS"],
    ["USER_DISABLED", 400, "USER_DISABLED"],
    [
      "TOO_MANY_ATTEMPTS_TRY_LATER : Access to this account has been disabled",
      400,
      "TOO_MANY_ATTEMPTS",
    ],
  ])("maps %s to %s", async (message, status, reason) => {
    await expect(
      signInWithPassword(
        { apiKey: "k", fetch: respond({ error: { message } }, status) },
        "a@b.co",
        "pw",
      ),
    ).resolves.toEqual({ ok: false, reason });
  });

  it("refuses accounts that need a second factor", async () => {
    await expect(
      signInWithPassword(
        { apiKey: "k", fetch: respond({ mfaPendingCredential: "x", localId: "u" }) },
        "a@b.co",
        "pw",
      ),
    ).resolves.toEqual({ ok: false, reason: "MFA_REQUIRED" });
  });

  it("throws on configuration problems and outages instead of blaming the password", async () => {
    await expect(
      signInWithPassword(
        { apiKey: "bad", fetch: respond({ error: { message: "API_KEY_INVALID" } }, 400) },
        "a@b.co",
        "pw",
      ),
    ).rejects.toThrow(IdentityToolkitError);
    await expect(
      signInWithPassword({ apiKey: "k", fetch: respond({}, 503) }, "a@b.co", "pw"),
    ).rejects.toThrow("HTTP 503");
    await expect(
      signInWithPassword({ apiKey: "k", fetch: respond({ localId: "u" }) }, "a@b.co", "pw"),
    ).rejects.toThrow("no ID token");
    await expect(
      signInWithPassword(
        { apiKey: "k", fetch: vi.fn<typeof fetch>(() => Promise.reject(new Error("down"))) },
        "a@b.co",
        "pw",
      ),
    ).rejects.toThrow("request failed");
  });

  it("never puts the password in an error", async () => {
    const error: unknown = await signInWithPassword(
      { apiKey: "k", fetch: respond({ error: { message: "WEIRD" } }, 500) },
      "a@b.co",
      "hunter2-password",
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(IdentityToolkitError);
    expect((error as Error).message).not.toContain("hunter2");
  });
});
