import { describe, expect, it } from "vitest";
import type { Env } from "../../src/lib/env";
import { ConfigError, loadConfig } from "../../src/lib/env";
import { TEST_ENV } from "../helpers";

const AUD = "a".repeat(64);

const production: Env = {
  ENVIRONMENT: "production",
  TURNSTILE_SECRET_KEY: "SECRET-TURNSTILE",
  PHONE_HASH_PEPPER: "SECRET-PEPPER-SECRET-PEPPER-SECRET",
  ACCESS_TEAM_DOMAIN: "lensarent.cloudflareaccess.com",
  ACCESS_AUD: AUD,
  ADMIN_EMAILS: " Owner@Example.com, staff@example.com ",
  DB: TEST_ENV.DB,
};

describe("loadConfig", () => {
  it("accepts local tests with a development admin", () => {
    expect(loadConfig(TEST_ENV)).toEqual({
      environment: "test",
      deployed: false,
      turnstileSecretKey: "test-turnstile-secret",
      phoneHashPepper: "test-pepper-test-pepper-test-pepper",
      adminAuth: { mode: "dev", email: "admin@lensarent.test" },
      chip: undefined,
      email: undefined,
      siteOrigin: undefined,
      alertEmails: ["admin@lensarent.test"],
    });
  });

  it("enables email only with both the Resend key and a sender", () => {
    expect(
      loadConfig({
        ...production,
        RESEND_API_KEY: "SECRET-RESEND",
        EMAIL_FROM: "LensaRent <tempahan@example.com>",
        SITE_ORIGIN: "https://example.com",
      }),
    ).toMatchObject({
      email: { resendApiKey: "SECRET-RESEND", from: "LensaRent <tempahan@example.com>" },
      siteOrigin: "https://example.com",
    });
    expect(() => loadConfig({ ...production, RESEND_API_KEY: "SECRET-RESEND" })).toThrow(
      /must be set together/,
    );
    expect(() => loadConfig({ ...production, SITE_ORIGIN: "https://example.com/" })).toThrow(
      /SITE_ORIGIN/,
    );
    expect(() =>
      loadConfig({ ...production, RESEND_API_KEY: "k", EMAIL_FROM: "Evil\r\nBcc: x@y.z" }),
    ).toThrow(/EMAIL_FROM/);
  });

  it("enables CHIP only with both the key and the brand id", () => {
    expect(
      loadConfig({ ...production, CHIP_SECRET_KEY: "SECRET-CHIP", CHIP_BRAND_ID: "brand-1" }),
    ).toMatchObject({
      chip: { secretKey: "SECRET-CHIP", brandId: "brand-1", publicKeyPem: undefined },
      alertEmails: ["owner@example.com", "staff@example.com"],
    });
    expect(() => loadConfig({ ...production, CHIP_SECRET_KEY: "SECRET-CHIP" })).toThrow(
      /CHIP_BRAND_ID CHIP_SECRET_KEY and CHIP_BRAND_ID must be set together/,
    );
    expect(() =>
      loadConfig({ ...production, CHIP_SECRET_KEY: "x", CHIP_BRAND_ID: "y", CHIP_PUBLIC_KEY: "z" }),
    ).toThrow(/CHIP_PUBLIC_KEY/);
    expect(() => loadConfig({ ...production, CHIP_SECRET_KEY: "x", CHIP_BRAND_ID: "a b" })).toThrow(
      /CHIP_BRAND_ID must be a CHIP brand id/,
    );
  });

  it("accepts a deployed environment protected by Cloudflare Access", () => {
    expect(loadConfig(production)).toMatchObject({
      environment: "production",
      deployed: true,
      adminAuth: {
        mode: "access",
        teamDomain: "lensarent.cloudflareaccess.com",
        audience: AUD,
        adminEmails: new Set(["owner@example.com", "staff@example.com"]),
      },
    });
    expect(loadConfig({ ...production, ENVIRONMENT: "staging" }).deployed).toBe(true);
  });

  it("uses Access locally too when no development admin is set", () => {
    expect(
      loadConfig({
        ...TEST_ENV,
        ACCESS_DEV_EMAIL: undefined,
        ACCESS_TEAM_DOMAIN: "lensarent.cloudflareaccess.com",
        ACCESS_AUD: AUD,
        ADMIN_EMAILS: "owner@example.com",
      }).adminAuth.mode,
    ).toBe("access");
  });

  const invalid: [string, Env, string][] = [
    [
      "a development admin in production",
      { ...production, ACCESS_DEV_EMAIL: "me@example.com" },
      "ACCESS_DEV_EMAIL must not be set in a deployed environment",
    ],
    [
      "production without an Access audience",
      { ...production, ACCESS_AUD: undefined },
      "ACCESS_AUD is required",
    ],
    [
      "production without admin emails",
      { ...production, ADMIN_EMAILS: "" },
      "ADMIN_EMAILS is required",
    ],
    [
      "an admin list that is not emails",
      { ...production, ADMIN_EMAILS: "owner, nobody" },
      "ADMIN_EMAILS must be a comma-separated list of emails",
    ],
    [
      "a team domain that is not Cloudflare Access",
      { ...production, ACCESS_TEAM_DOMAIN: "evil.example.com" },
      "ACCESS_TEAM_DOMAIN must look like <team>.cloudflareaccess.com",
    ],
    [
      "a malformed AUD tag",
      { ...production, ACCESS_AUD: "not-hex" },
      "ACCESS_AUD must be the Access application's AUD tag",
    ],
    [
      "a missing Turnstile secret",
      { ...production, TURNSTILE_SECRET_KEY: undefined },
      "TURNSTILE_SECRET_KEY is required",
    ],
    [
      "a short pepper",
      { ...production, PHONE_HASH_PEPPER: "SECRET-short" },
      "PHONE_HASH_PEPPER must be at least 32 characters",
    ],
    ["a missing D1 binding", { ...production, DB: undefined }, "DB (D1 binding) is required"],
    ["an unknown environment name", { ...TEST_ENV, ENVIRONMENT: "prod" }, "ENVIRONMENT"],
  ];

  it.each(invalid)("rejects %s", (_label, env, problem) => {
    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(() => loadConfig(env)).toThrow(problem);
  });

  it("never puts a secret's value in the error", () => {
    const messages = [
      { ...production, PHONE_HASH_PEPPER: "SECRET-short" },
      { ...production, ACCESS_DEV_EMAIL: "SECRET@example.com" },
      { ...production, ACCESS_AUD: "SECRET" },
    ].map((env) => {
      try {
        loadConfig(env);
        return "";
      } catch (caught) {
        return (caught as Error).message;
      }
    });
    for (const message of messages) {
      expect(message).not.toBe("");
      expect(message).not.toContain("SECRET");
    }
  });
});
