import type { JSONWebKeySet, JWTPayload } from "jose";
import { SignJWT, UnsecuredJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACCESS_JWT_HEADER,
  clearAccessKeyCache,
  createAccessVerifier,
  createDevAdminVerifier,
} from "../../src/lib/access";

const TEAM = "lensarent.cloudflareaccess.com";
const AUD = "b".repeat(64);
const NOW = new Date("2026-12-24T12:00:00.000Z");
const nowSeconds = Math.floor(NOW.getTime() / 1000);

let privateKey: CryptoKey;
let otherKey: CryptoKey;
let jwks: JSONWebKeySet;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  const other = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  otherKey = other.privateKey;
  jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256" }] };
});

beforeEach(() => {
  clearAccessKeyCache();
});

const goodClaims: JWTPayload = {
  iss: `https://${TEAM}`,
  aud: [AUD],
  sub: "user-123",
  email: "Owner@Example.com",
  iat: nowSeconds - 60,
  exp: nowSeconds + 3600,
  type: "app",
};

function sign(claims: JWTPayload, key = privateKey, kid = "k1"): Promise<string> {
  return new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid }).sign(key);
}

function withToken(token?: string): Request {
  return new Request("https://lensarent.test/api/admin/leads", {
    headers: token ? { [ACCESS_JWT_HEADER]: token } : {},
  });
}

const adminEmails = new Set(["owner@example.com"]);

describe("createAccessVerifier", () => {
  const verifier = () =>
    createAccessVerifier({
      teamDomain: TEAM,
      audience: AUD,
      adminEmails,
      keys: createLocalJWKSet(jwks),
      now: () => NOW,
    });

  it("accepts a valid Access token for an allowed admin", async () => {
    await expect(verifier().verify(withToken(await sign(goodClaims)))).resolves.toEqual({
      id: "user-123",
      email: "owner@example.com",
    });
  });

  it.each([
    ["another application's audience", { aud: ["c".repeat(64)] }],
    ["another team as issuer", { iss: "https://evil.cloudflareaccess.com" }],
    ["an expired token", { exp: nowSeconds - 120 }],
    ["an email that is not on the admin list", { email: "stranger@example.com" }],
    ["no email", { email: undefined }],
    ["no subject", { sub: undefined }],
  ])("refuses %s", async (_label, override) => {
    await expect(
      verifier().verify(withToken(await sign({ ...goodClaims, ...override }))),
    ).resolves.toBeNull();
  });

  it("refuses a token signed by another key, an unsigned token, garbage and no token", async () => {
    await expect(
      verifier().verify(withToken(await sign(goodClaims, otherKey))),
    ).resolves.toBeNull();
    await expect(
      verifier().verify(withToken(new UnsecuredJWT(goodClaims).encode())),
    ).resolves.toBeNull();
    await expect(verifier().verify(withToken("not-a-jwt"))).resolves.toBeNull();
    await expect(verifier().verify(withToken())).resolves.toBeNull();
  });

  describe("with the team's published keys", () => {
    const certs = (body: unknown, status = 200) =>
      vi.fn<typeof fetch>(() => Promise.resolve(Response.json(body, { status })));

    it("fetches the certs once and caches them", async () => {
      const fetchMock = certs(jwks);
      const make = () =>
        createAccessVerifier({
          teamDomain: TEAM,
          audience: AUD,
          adminEmails,
          fetch: fetchMock,
          now: () => NOW,
        });
      const token = await sign(goodClaims);

      await expect(make().verify(withToken(token))).resolves.toMatchObject({ id: "user-123" });
      await expect(make().verify(withToken(token))).resolves.toMatchObject({ id: "user-123" });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0]![0]).toBe(`https://${TEAM}/cdn-cgi/access/certs`);
    });

    it("refetches once when Cloudflare has rotated to a key it has not seen", async () => {
      const rotated = await generateKeyPair("RS256");
      const rotatedJwks = {
        keys: [{ ...(await exportJWK(rotated.publicKey)), kid: "k2", alg: "RS256" }],
      };
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json(jwks))
        .mockResolvedValueOnce(Response.json(rotatedJwks));
      const make = () =>
        createAccessVerifier({
          teamDomain: TEAM,
          audience: AUD,
          adminEmails,
          fetch: fetchMock,
          now: () => NOW,
        });

      await make().verify(withToken(await sign(goodClaims)));
      const newToken = await sign(goodClaims, rotated.privateKey, "k2");
      await expect(make().verify(withToken(newToken))).resolves.toMatchObject({ id: "user-123" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("fails closed when the certs cannot be fetched", async () => {
      const verifier = createAccessVerifier({
        teamDomain: TEAM,
        audience: AUD,
        adminEmails,
        fetch: certs({}, 503),
        now: () => NOW,
      });
      await expect(verifier.verify(withToken(await sign(goodClaims)))).resolves.toBeNull();
    });
  });
});

describe("createDevAdminVerifier", () => {
  it("treats every request as the configured development admin", async () => {
    await expect(createDevAdminVerifier("me@example.com").verify(withToken())).resolves.toEqual({
      id: "dev:me@example.com",
      email: "me@example.com",
    });
  });
});
