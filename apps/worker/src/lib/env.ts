import { z } from "zod";

export const ENVIRONMENTS = ["development", "test", "staging", "production"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

/** Bindings exactly as Cloudflare hands them over. Untrusted until `loadConfig` parses them. */
export interface Env {
  ENVIRONMENT?: string;
  FIREBASE_PROJECT_ID?: string;
  /** Secret: the full service-account JSON. Never logged, never sent to the browser. */
  FIREBASE_SERVICE_ACCOUNT?: string;
  /**
   * Secret by choice: the Firebase Web API key. Only the Worker calls the sign-in API, so the
   * key never reaches a browser and nobody else can use it to create accounts.
   */
  FIREBASE_API_KEY?: string;
  /** Secret: Cloudflare Turnstile secret key. */
  TURNSTILE_SECRET_KEY?: string;
  /** Secret: pepper for the HMAC of phone numbers and IP addresses. */
  PHONE_HASH_PEPPER?: string;
  /** Local development and tests only. */
  FIRESTORE_EMULATOR_HOST?: string;
  /** Local development and tests only. */
  FIREBASE_AUTH_EMULATOR_HOST?: string;
  ASSETS?: Fetcher;
  /** Workers Rate Limiting binding: a cheap first line against bursts from one IP. */
  RL_BURST?: RateLimit;
}

export interface AppConfig {
  environment: Environment;
  /** Staging and production: strict checks apply (Turnstile hostname/action, no emulators). */
  deployed: boolean;
  firebaseProjectId: string;
  serviceAccountJson: string | undefined;
  firebaseApiKey: string;
  turnstileSecretKey: string;
  phoneHashPepper: string;
  firestoreEmulatorHost: string | undefined;
  authEmulatorHost: string | undefined;
}

export class ConfigError extends Error {
  constructor(problems: readonly string[]) {
    super(`Invalid Worker configuration: ${problems.join("; ")}`);
    this.name = "ConfigError";
  }
}

/** Unset and empty bindings are treated the same. */
const optionalText = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().optional(),
);
const requiredText = z.string().min(1, "is required");

// Loopback only: the emulators accept any caller as the owner, so they must never be remote.
const emulatorHost = optionalText.refine(
  (value) => value === undefined || /^(127\.0\.0\.1|localhost):\d{2,5}$/.test(value),
  "must be a loopback host:port",
);

const configSchema = z
  .object({
    ENVIRONMENT: z.enum(ENVIRONMENTS),
    FIREBASE_PROJECT_ID: z.string().regex(/^[a-z][a-z0-9-]{4,29}$/, "is not a Firebase project id"),
    FIREBASE_SERVICE_ACCOUNT: optionalText,
    FIREBASE_API_KEY: requiredText,
    TURNSTILE_SECRET_KEY: requiredText,
    PHONE_HASH_PEPPER: z.string().min(32, "must be at least 32 characters"),
    FIRESTORE_EMULATOR_HOST: emulatorHost,
    FIREBASE_AUTH_EMULATOR_HOST: emulatorHost,
  })
  .superRefine((value, context) => {
    const deployed = value.ENVIRONMENT === "staging" || value.ENVIRONMENT === "production";
    for (const key of ["FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST"] as const) {
      if (deployed && value[key] !== undefined) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: "must not be set in a deployed environment",
        });
      }
    }
    if (
      value.FIRESTORE_EMULATOR_HOST === undefined &&
      value.FIREBASE_SERVICE_ACCOUNT === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["FIREBASE_SERVICE_ACCOUNT"],
        message: "is required when no emulator host is set",
      });
    }
  });

/**
 * Validates the Worker's bindings. Problems name the binding only, never its value, so a
 * misconfigured secret cannot end up in a log line.
 */
export function loadConfig(env: Env): AppConfig {
  const parsed = configSchema.safeParse({
    ENVIRONMENT: env.ENVIRONMENT,
    FIREBASE_PROJECT_ID: env.FIREBASE_PROJECT_ID,
    FIREBASE_SERVICE_ACCOUNT: env.FIREBASE_SERVICE_ACCOUNT,
    FIREBASE_API_KEY: env.FIREBASE_API_KEY,
    TURNSTILE_SECRET_KEY: env.TURNSTILE_SECRET_KEY,
    PHONE_HASH_PEPPER: env.PHONE_HASH_PEPPER,
    FIRESTORE_EMULATOR_HOST: env.FIRESTORE_EMULATOR_HOST,
    FIREBASE_AUTH_EMULATOR_HOST: env.FIREBASE_AUTH_EMULATOR_HOST,
  });
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => {
        const binding = issue.path.join(".");
        // zod's own messages for a missing value mention the received type, never the value.
        return issue.code === "invalid_type"
          ? `${binding} is required`
          : `${binding} ${issue.message}`;
      }),
    );
  }
  const data = parsed.data;
  return {
    environment: data.ENVIRONMENT,
    deployed: data.ENVIRONMENT === "staging" || data.ENVIRONMENT === "production",
    firebaseProjectId: data.FIREBASE_PROJECT_ID,
    serviceAccountJson: data.FIREBASE_SERVICE_ACCOUNT,
    firebaseApiKey: data.FIREBASE_API_KEY,
    turnstileSecretKey: data.TURNSTILE_SECRET_KEY,
    phoneHashPepper: data.PHONE_HASH_PEPPER,
    firestoreEmulatorHost: data.FIRESTORE_EMULATOR_HOST,
    authEmulatorHost: data.FIREBASE_AUTH_EMULATOR_HOST,
  };
}
