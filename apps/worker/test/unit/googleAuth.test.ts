import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServiceAccount } from "../../src/lib/googleAuth";
import {
  EmulatorTokenProvider,
  FIRESTORE_SCOPE,
  GOOGLE_TOKEN_URL,
  GoogleAuthError,
  ServiceAccountTokenProvider,
  clearTokenCache,
  parseServiceAccount,
  signServiceAccountJwt,
} from "../../src/lib/googleAuth";
import { decodeBase64Url, decodeJwtPart, generateTestServiceAccountKey } from "../helpers";

let account: ServiceAccount;
let publicKey: CryptoKey;

beforeAll(async () => {
  const key = await generateTestServiceAccountKey();
  publicKey = key.publicKey;
  account = {
    clientEmail: "worker@demo-lensarent.iam.gserviceaccount.com",
    privateKey: key.privateKeyPem,
    privateKeyId: "key-1",
  };
});

beforeEach(() => {
  clearTokenCache();
});

function tokenResponse(token: string, expiresIn = 3600): Response {
  return Response.json({ access_token: token, expires_in: expiresIn, token_type: "Bearer" });
}

describe("signServiceAccountJwt", () => {
  it("produces an RS256 JWT that verifies against the public key", async () => {
    const jwt = await signServiceAccountJwt(account, {
      scope: FIRESTORE_SCOPE,
      aud: GOOGLE_TOKEN_URL,
      iat: 1_800_000_000,
      exp: 1_800_003_600,
    });
    const [header, payload, signature] = jwt.split(".");

    expect(decodeJwtPart(header!)).toEqual({ alg: "RS256", typ: "JWT", kid: "key-1" });
    expect(decodeJwtPart(payload!)).toEqual({
      iss: "worker@demo-lensarent.iam.gserviceaccount.com",
      scope: FIRESTORE_SCOPE,
      aud: GOOGLE_TOKEN_URL,
      iat: 1_800_000_000,
      exp: 1_800_003_600,
    });
    const verified = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      decodeBase64Url(signature!),
      new TextEncoder().encode(`${header!}.${payload!}`),
    );
    expect(verified).toBe(true);
  });

  it("omits the key id when the account has none", async () => {
    const jwt = await signServiceAccountJwt(
      { ...account, privateKeyId: undefined },
      { scope: FIRESTORE_SCOPE, aud: GOOGLE_TOKEN_URL, iat: 1, exp: 2 },
    );
    expect(decodeJwtPart(jwt.split(".")[0]!)).toEqual({ alg: "RS256", typ: "JWT" });
  });

  it("rejects keys that are not PKCS#8", async () => {
    const claims = { scope: FIRESTORE_SCOPE, aud: GOOGLE_TOKEN_URL, iat: 1, exp: 2 };
    await expect(
      signServiceAccountJwt(
        {
          ...account,
          privateKey: "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----",
        },
        claims,
      ),
    ).rejects.toThrow(GoogleAuthError);
    await expect(
      signServiceAccountJwt(
        { ...account, privateKey: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----" },
        claims,
      ),
    ).rejects.toThrow("could not be imported");
  });
});

describe("ServiceAccountTokenProvider", () => {
  it("exchanges a signed assertion for an access token", async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(tokenResponse("token-1")));
    const provider = new ServiceAccountTokenProvider(account, [FIRESTORE_SCOPE], {
      fetch: fetchMock,
      now: () => 1_800_000_000_000,
    });

    await expect(provider.getToken()).resolves.toBe("token-1");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(GOOGLE_TOKEN_URL);
    expect(init?.method).toBe("POST");
    const body = new URLSearchParams(init?.body as string);
    expect(body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const claims = decodeJwtPart(body.get("assertion")!.split(".")[1]!);
    expect(claims).toMatchObject({
      aud: GOOGLE_TOKEN_URL,
      scope: FIRESTORE_SCOPE,
      iat: 1_800_000_000,
      exp: 1_800_003_600,
    });
  });

  it("reuses a cached token, including across provider instances", async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(tokenResponse("token-1")));
    const deps = { fetch: fetchMock, now: () => 1_800_000_000_000 };
    const first = new ServiceAccountTokenProvider(account, [FIRESTORE_SCOPE], deps);
    const second = new ServiceAccountTokenProvider(account, [FIRESTORE_SCOPE], deps);

    await first.getToken();
    await first.getToken();
    await expect(second.getToken()).resolves.toBe("token-1");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not share a token between different scopes", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse("firestore-token"))
      .mockResolvedValueOnce(tokenResponse("storage-token"));
    const deps = { fetch: fetchMock, now: () => 1_800_000_000_000 };

    await expect(
      new ServiceAccountTokenProvider(account, [FIRESTORE_SCOPE], deps).getToken(),
    ).resolves.toBe("firestore-token");
    await expect(
      new ServiceAccountTokenProvider(account, ["https://example.test/storage"], deps).getToken(),
    ).resolves.toBe("storage-token");
  });

  it("refreshes shortly before the token expires", async () => {
    let now = 1_800_000_000_000;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse("token-1", 3600))
      .mockResolvedValueOnce(tokenResponse("token-2", 3600));
    const provider = new ServiceAccountTokenProvider(account, [FIRESTORE_SCOPE], {
      fetch: fetchMock,
      now: () => now,
    });

    await expect(provider.getToken()).resolves.toBe("token-1");
    now += 3_539_000; // 61 seconds of validity left: still good
    await expect(provider.getToken()).resolves.toBe("token-1");
    now += 2_000; // 59 seconds left: inside the refresh margin
    await expect(provider.getToken()).resolves.toBe("token-2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("makes one token request for concurrent callers", async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(tokenResponse("token-1")));
    const provider = new ServiceAccountTokenProvider(account, [FIRESTORE_SCOPE], {
      fetch: fetchMock,
    });

    const tokens = await Promise.all([
      provider.getToken(),
      provider.getToken(),
      provider.getToken(),
    ]);
    expect(tokens).toEqual(["token-1", "token-1", "token-1"]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("reports a rejected request without repeating Google's response", async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        Response.json(
          { error: "invalid_grant", error_description: "Invalid JWT for worker@demo-lensarent" },
          { status: 400 },
        ),
      ),
    );
    const provider = new ServiceAccountTokenProvider(account, [FIRESTORE_SCOPE], {
      fetch: fetchMock,
    });

    const error = await provider.getToken().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GoogleAuthError);
    expect((error as Error).message).toBe("Google token request was rejected (HTTP 400)");
  });

  it("can try again after a failure", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce(new Response("not json"))
      .mockResolvedValueOnce(tokenResponse("token-1"));
    const provider = new ServiceAccountTokenProvider(account, [FIRESTORE_SCOPE], {
      fetch: fetchMock,
    });

    await expect(provider.getToken()).rejects.toThrow("Google token request failed");
    await expect(provider.getToken()).rejects.toThrow("Google token response was not understood");
    await expect(provider.getToken()).resolves.toBe("token-1");
  });
});

describe("parseServiceAccount", () => {
  it("reads the fields the Worker needs", () => {
    const json = JSON.stringify({
      type: "service_account",
      project_id: "demo-lensarent",
      private_key_id: "key-1",
      private_key: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n",
      client_email: "worker@demo-lensarent.iam.gserviceaccount.com",
    });
    expect(parseServiceAccount(json)).toEqual({
      clientEmail: "worker@demo-lensarent.iam.gserviceaccount.com",
      privateKey: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n",
      privateKeyId: "key-1",
    });
  });

  it.each([
    ["text that is not JSON", "SECRET-not-json"],
    ["JSON without a private key", JSON.stringify({ client_email: "a@b.co", note: "SECRET" })],
    ["JSON without a client email", JSON.stringify({ private_key: "SECRET" })],
    ["a JSON array", JSON.stringify(["SECRET"])],
  ])("rejects %s without echoing it", (_label, json) => {
    const error = (() => {
      try {
        parseServiceAccount(json);
        return undefined;
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(GoogleAuthError);
    expect((error as Error).message).not.toContain("SECRET");
  });
});

describe("EmulatorTokenProvider", () => {
  it("returns the emulator's owner token", async () => {
    await expect(new EmulatorTokenProvider().getToken()).resolves.toBe("owner");
  });
});
