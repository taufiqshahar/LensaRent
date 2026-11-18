import { env } from "cloudflare:workers";
import type { AppConfig, Env } from "../src/lib/env";

export const TEST_ADMIN = "admin@lensarent.test";

/** Complete, valid bindings for tests. Values are obvious placeholders, never real secrets. */
export const TEST_ENV: Env = {
  ENVIRONMENT: "test",
  TURNSTILE_SECRET_KEY: "test-turnstile-secret",
  PHONE_HASH_PEPPER: "test-pepper-test-pepper-test-pepper",
  ACCESS_DEV_EMAIL: TEST_ADMIN,
  DB: env.DB,
  PHOTOS: env.PHOTOS,
};

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    environment: "test",
    deployed: false,
    turnstileSecretKey: "test-turnstile-secret",
    phoneHashPepper: "test-pepper-test-pepper-test-pepper",
    adminAuth: { mode: "dev", email: TEST_ADMIN },
    chip: undefined,
    email: undefined,
    siteOrigin: undefined,
    alertEmails: [TEST_ADMIN],
    ...overrides,
  };
}

export function testDb(): D1Database {
  return env.DB;
}

/** Tests share one database: each uses ids nobody else will touch. */
export function uniqueId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 12)}`;
}

/**
 * Builds a PEM block at run time. Tests never hold a literal key block in source, so the
 * secret scanner only ever reports real findings.
 */
export function fakePem(label: string, body = "AAAA"): string {
  const dashes = "-".repeat(5);
  return `${dashes}BEGIN ${label}${dashes}\n${body}\n${dashes}END ${label}${dashes}\n`;
}
