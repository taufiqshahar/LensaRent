import { describe, expect, it } from "vitest";
import type { Env } from "../../src/lib/env";
import { ConfigError, loadConfig } from "../../src/lib/env";

const SERVICE_ACCOUNT = '{"private_key":"SECRET-SECRET-SECRET"}';

describe("loadConfig", () => {
  it("accepts local development against the emulator", () => {
    expect(
      loadConfig({
        ENVIRONMENT: "development",
        FIREBASE_PROJECT_ID: "demo-lensarent",
        FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
        FIREBASE_SERVICE_ACCOUNT: "",
      }),
    ).toEqual({
      environment: "development",
      firebaseProjectId: "demo-lensarent",
      serviceAccountJson: undefined,
      firestoreEmulatorHost: "127.0.0.1:8080",
    });
  });

  it("accepts a deployed environment with a service account", () => {
    expect(
      loadConfig({
        ENVIRONMENT: "production",
        FIREBASE_PROJECT_ID: "lensarent-production",
        FIREBASE_SERVICE_ACCOUNT: SERVICE_ACCOUNT,
        FIRESTORE_EMULATOR_HOST: "",
      }),
    ).toEqual({
      environment: "production",
      firebaseProjectId: "lensarent-production",
      serviceAccountJson: SERVICE_ACCOUNT,
      firestoreEmulatorHost: undefined,
    });
  });

  const invalid: [string, Env, string][] = [
    [
      "an emulator host in production",
      {
        ENVIRONMENT: "production",
        FIREBASE_PROJECT_ID: "lensarent-production",
        FIREBASE_SERVICE_ACCOUNT: SERVICE_ACCOUNT,
        FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
      },
      "FIRESTORE_EMULATOR_HOST must not be set in a deployed environment",
    ],
    [
      "an emulator host in staging",
      {
        ENVIRONMENT: "staging",
        FIREBASE_PROJECT_ID: "lensarent-staging",
        FIRESTORE_EMULATOR_HOST: "localhost:8080",
      },
      "FIRESTORE_EMULATOR_HOST must not be set in a deployed environment",
    ],
    [
      "production without credentials",
      { ENVIRONMENT: "production", FIREBASE_PROJECT_ID: "lensarent-production" },
      "FIREBASE_SERVICE_ACCOUNT is required",
    ],
    [
      "development with neither emulator nor credentials",
      { ENVIRONMENT: "development", FIREBASE_PROJECT_ID: "demo-lensarent" },
      "FIREBASE_SERVICE_ACCOUNT is required",
    ],
    [
      "a remote emulator host",
      {
        ENVIRONMENT: "development",
        FIREBASE_PROJECT_ID: "demo-lensarent",
        FIRESTORE_EMULATOR_HOST: "evil.example.com:8080",
      },
      "FIRESTORE_EMULATOR_HOST must be a loopback host:port",
    ],
    [
      "an unknown environment name",
      {
        ENVIRONMENT: "prod",
        FIREBASE_PROJECT_ID: "demo-lensarent",
        FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
      },
      "ENVIRONMENT",
    ],
    [
      "a missing environment name",
      { FIREBASE_PROJECT_ID: "demo-lensarent", FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" },
      "ENVIRONMENT",
    ],
    [
      "a malformed project id",
      {
        ENVIRONMENT: "test",
        FIREBASE_PROJECT_ID: "Not A Project",
        FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
      },
      "FIREBASE_PROJECT_ID is not a Firebase project id",
    ],
  ];

  it.each(invalid)("rejects %s", (_label, env, problem) => {
    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(() => loadConfig(env)).toThrow(problem);
  });

  it("never puts a secret's value in the error", () => {
    const error = (() => {
      try {
        loadConfig({
          ENVIRONMENT: "production",
          FIREBASE_PROJECT_ID: "lensarent-production",
          FIREBASE_SERVICE_ACCOUNT: SERVICE_ACCOUNT,
          FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
        });
        return undefined;
      } catch (caught) {
        return caught as Error;
      }
    })();
    expect(error?.message).not.toContain("SECRET-SECRET");
  });
});
