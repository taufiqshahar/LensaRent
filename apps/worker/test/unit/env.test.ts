import { describe, expect, it } from "vitest";
import type { Env } from "../../src/lib/env";
import { ConfigError, loadConfig } from "../../src/lib/env";
import { TEST_ENV } from "../helpers";

const SERVICE_ACCOUNT = '{"private_key":"SECRET-SECRET-SECRET"}';

const production: Env = {
  ENVIRONMENT: "production",
  FIREBASE_PROJECT_ID: "lensarent-production",
  FIREBASE_SERVICE_ACCOUNT: SERVICE_ACCOUNT,
  FIREBASE_API_KEY: "SECRET-API-KEY",
  TURNSTILE_SECRET_KEY: "SECRET-TURNSTILE",
  PHONE_HASH_PEPPER: "SECRET-PEPPER-SECRET-PEPPER-SECRET",
};

describe("loadConfig", () => {
  it("accepts local tests against the emulators", () => {
    expect(loadConfig({ ...TEST_ENV, FIREBASE_SERVICE_ACCOUNT: "" })).toEqual({
      environment: "test",
      deployed: false,
      firebaseProjectId: "demo-lensarent",
      serviceAccountJson: undefined,
      firebaseApiKey: "demo-api-key",
      turnstileSecretKey: "test-turnstile-secret",
      phoneHashPepper: "test-pepper-test-pepper-test-pepper",
      firestoreEmulatorHost: "127.0.0.1:8080",
      authEmulatorHost: "127.0.0.1:9099",
    });
  });

  it("accepts a deployed environment with real credentials", () => {
    expect(loadConfig({ ...production, FIRESTORE_EMULATOR_HOST: "" })).toMatchObject({
      environment: "production",
      deployed: true,
      serviceAccountJson: SERVICE_ACCOUNT,
      firestoreEmulatorHost: undefined,
      authEmulatorHost: undefined,
    });
    expect(loadConfig({ ...production, ENVIRONMENT: "staging" }).deployed).toBe(true);
  });

  const invalid: [string, Env, string][] = [
    [
      "a Firestore emulator in production",
      { ...production, FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" },
      "FIRESTORE_EMULATOR_HOST must not be set in a deployed environment",
    ],
    [
      "an Auth emulator in staging",
      { ...production, ENVIRONMENT: "staging", FIREBASE_AUTH_EMULATOR_HOST: "localhost:9099" },
      "FIREBASE_AUTH_EMULATOR_HOST must not be set in a deployed environment",
    ],
    [
      "production without a service account",
      { ...production, FIREBASE_SERVICE_ACCOUNT: undefined },
      "FIREBASE_SERVICE_ACCOUNT is required",
    ],
    [
      "a missing Turnstile secret",
      { ...production, TURNSTILE_SECRET_KEY: undefined },
      "TURNSTILE_SECRET_KEY is required",
    ],
    ["an empty API key", { ...production, FIREBASE_API_KEY: "" }, "FIREBASE_API_KEY is required"],
    [
      "a short pepper",
      { ...production, PHONE_HASH_PEPPER: "SECRET-short" },
      "PHONE_HASH_PEPPER must be at least 32 characters",
    ],
    [
      "a remote emulator host",
      { ...TEST_ENV, FIREBASE_AUTH_EMULATOR_HOST: "evil.example.com:9099" },
      "FIREBASE_AUTH_EMULATOR_HOST must be a loopback host:port",
    ],
    ["an unknown environment name", { ...TEST_ENV, ENVIRONMENT: "prod" }, "ENVIRONMENT"],
    [
      "a malformed project id",
      { ...TEST_ENV, FIREBASE_PROJECT_ID: "Not A Project" },
      "FIREBASE_PROJECT_ID is not a Firebase project id",
    ],
  ];

  it.each(invalid)("rejects %s", (_label, env, problem) => {
    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(() => loadConfig(env)).toThrow(problem);
  });

  it("never puts a secret's value in the error", () => {
    const messages = [
      { ...production, FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" },
      { ...production, PHONE_HASH_PEPPER: "SECRET-short" },
      { ...production, FIREBASE_PROJECT_ID: "SECRET PROJECT" },
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
