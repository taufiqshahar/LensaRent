import { describe, expect, it, vi } from "vitest";
import { createHasher, randomToken, sha256 } from "../../src/lib/crypto";
import { csvField, toCsv } from "../../src/lib/csv";
import { MAX_JSON_BYTES, clientIp, isSameOrigin, readJson } from "../../src/lib/http";
import {
  SESSION_COOKIE,
  clearedSessionCookie,
  readSessionToken,
  sessionCookie,
} from "../../src/lib/sessions";
import { TURNSTILE_VERIFY_URL, createTurnstileVerifier } from "../../src/lib/turnstile";

describe("hashing", () => {
  it("is stable for the same purpose and value, and differs across purposes and peppers", async () => {
    const hasher = createHasher("pepper-pepper-pepper-pepper-pepper");
    const a = await hasher.hash("phone", "+60174913169");
    expect(await hasher.hash("phone", "+60174913169")).toBe(a);
    expect(await hasher.hash("ip", "+60174913169")).not.toBe(a);
    expect(
      await createHasher("another-pepper-another-pepper-xx").hash("phone", "+60174913169"),
    ).not.toBe(a);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("makes unguessable tokens and hashes them", async () => {
    const token = randomToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(token);
    expect(await sha256("abc")).toBe("ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0");
  });
});

describe("readJson", () => {
  const post = (
    body: BodyInit | null,
    headers: Record<string, string> = { "content-type": "application/json" },
  ) => new Request("https://lensarent.test/api/x", { method: "POST", body, headers });

  it("parses a JSON body", async () => {
    const result = await readJson(post('{"a":1}'));
    expect(result).toEqual({ ok: true, value: { a: 1 } });
    expect(
      await readJson(post("{}", { "content-type": "application/json; charset=utf-8" })),
    ).toEqual({
      ok: true,
      value: {},
    });
  });

  it.each([
    ["a form post", post("a=1", { "content-type": "application/x-www-form-urlencoded" }), 415],
    ["no content type", post('{"a":1}', {}), 415],
    ["broken JSON", post("{nope"), 400],
    ["an empty body", post(null), 400],
    ["a body over the limit", post(`"${"x".repeat(MAX_JSON_BYTES)}"`), 413],
    [
      "a declared length over the limit",
      post("{}", {
        "content-type": "application/json",
        "content-length": String(MAX_JSON_BYTES + 1),
      }),
      413,
    ],
  ])("refuses %s", async (_label, request, status) => {
    const result = await readJson(request);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(status);
  });
});

describe("request helpers", () => {
  it("reads the client IP from Cloudflare's header", () => {
    expect(
      clientIp(new Request("https://x.test", { headers: { "cf-connecting-ip": "203.0.113.9" } })),
    ).toBe("203.0.113.9");
    expect(clientIp(new Request("https://x.test"))).toBeUndefined();
  });

  it("accepts only requests from our own origin", () => {
    const url = new URL("https://lensarent.test/api/admin/session");
    const withOrigin = (origin?: string) =>
      new Request(url, { method: "POST", headers: origin ? { origin } : {} });
    expect(isSameOrigin(withOrigin("https://lensarent.test"), url)).toBe(true);
    expect(isSameOrigin(withOrigin("https://evil.test"), url)).toBe(false);
    expect(isSameOrigin(withOrigin("http://lensarent.test"), url)).toBe(false);
    expect(isSameOrigin(withOrigin(), url)).toBe(false);
  });
});

describe("session cookies", () => {
  it("are HttpOnly, Secure, SameSite=Strict and host-only", () => {
    const cookie = sessionCookie("abc");
    expect(cookie).toMatch(/^__Host-lensarent_admin=abc; /);
    for (const attribute of ["Path=/", "HttpOnly", "Secure", "SameSite=Strict", "Max-Age=28800"]) {
      expect(cookie).toContain(attribute);
    }
    expect(cookie).not.toContain("Domain=");
    expect(clearedSessionCookie()).toContain("Max-Age=0");
  });

  it("are read back from the Cookie header", () => {
    const request = (cookie?: string) =>
      new Request("https://x.test", { headers: cookie ? { cookie } : {} });
    expect(readSessionToken(request(`theme=dark; ${SESSION_COOKIE}=tok123; other=1`))).toBe(
      "tok123",
    );
    expect(readSessionToken(request("theme=dark"))).toBeUndefined();
    expect(readSessionToken(request("broken; =x"))).toBeUndefined();
    expect(readSessionToken(request())).toBeUndefined();
  });
});

describe("CSV", () => {
  it("quotes every field and escapes quotes", () => {
    expect(csvField('Kata "hai"')).toBe('"Kata ""hai"""');
    expect(csvField("a,b\nc")).toBe('"a,b\nc"');
  });

  it.each(['=HYPERLINK("x")', "+60174913169", "-1", "@SUM(A1)", "\tx", "\rx"])(
    "defuses a field that a spreadsheet would run: %s",
    (value) => {
      expect(csvField(value).startsWith(`"'`)).toBe(true);
    },
  );

  it("writes a BOM and CRLF line endings", () => {
    expect(
      toCsv([
        ["Nama", "Telefon"],
        ["Ali", "017-491 3169"],
      ]),
    ).toBe('﻿"Nama","Telefon"\r\n"Ali","017-491 3169"\r\n');
  });
});

describe("Turnstile", () => {
  const check = {
    token: "tok",
    remoteIp: "203.0.113.9",
    expectedAction: "lead",
    expectedHostname: "lensarent.test",
  };
  const answer = (body: unknown, status = 200) =>
    vi.fn<typeof fetch>(() => Promise.resolve(Response.json(body, { status })));

  it("posts the secret, token and IP to siteverify", async () => {
    const fetchMock = answer({ success: true, hostname: "lensarent.test", action: "lead" });
    const verifier = createTurnstileVerifier({
      secretKey: "s3cret",
      strict: true,
      fetch: fetchMock,
    });

    await expect(verifier.verify(check)).resolves.toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(TURNSTILE_VERIFY_URL);
    const body = new URLSearchParams(init?.body as string);
    expect(Object.fromEntries(body)).toEqual({
      secret: "s3cret",
      response: "tok",
      remoteip: "203.0.113.9",
    });
  });

  it.each([
    ["a failed challenge", { success: false }],
    ["a token for another site", { success: true, hostname: "evil.test", action: "lead" }],
    ["a token for another action", { success: true, hostname: "lensarent.test", action: "login" }],
    ["a token without hostname or action", { success: true }],
  ])("refuses %s when strict", async (_label, body) => {
    const verifier = createTurnstileVerifier({ secretKey: "s", strict: true, fetch: answer(body) });
    await expect(verifier.verify(check)).resolves.toBe(false);
  });

  it("only checks success when not strict (Cloudflare test keys)", async () => {
    const verifier = createTurnstileVerifier({
      secretKey: "s",
      strict: false,
      fetch: answer({ success: true, hostname: "example.com", action: "" }),
    });
    await expect(verifier.verify({ ...check, remoteIp: undefined })).resolves.toBe(true);
  });

  it("throws when Turnstile itself fails, so the caller answers 500 rather than 403", async () => {
    const down = createTurnstileVerifier({ secretKey: "s", strict: true, fetch: answer({}, 503) });
    await expect(down.verify(check)).rejects.toThrow("HTTP 503");
    const garbled = createTurnstileVerifier({
      secretKey: "s",
      strict: true,
      fetch: answer({ ok: 1 }),
    });
    await expect(garbled.verify(check)).rejects.toThrow("not understood");
  });
});
