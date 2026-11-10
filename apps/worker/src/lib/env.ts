import { z } from "zod";

export const ENVIRONMENTS = ["development", "test", "staging", "production"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

/** Bindings exactly as Cloudflare hands them over. Untrusted until `loadConfig` parses them. */
export interface Env {
  ENVIRONMENT?: string;
  FIREBASE_PROJECT_ID?: string;
  /** Secret: the full service-account JSON. Never logged, never sent to the browser. */
  FIREBASE_SERVICE_ACCOUNT?: string;
  /** Local development and tests only. */
  FIRESTORE_EMULATOR_HOST?: string;
  ASSETS?: Fetcher;
}

export interface AppConfig {
  environment: Environment;
  firebaseProjectId: string;
  serviceAccountJson: string | undefined;
  firestoreEmulatorHost: string | undefined;
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

const configSchema = z
  .object({
    ENVIRONMENT: z.enum(ENVIRONMENTS),
    FIREBASE_PROJECT_ID: z.string().regex(/^[a-z][a-z0-9-]{4,29}$/, "is not a Firebase project id"),
    FIREBASE_SERVICE_ACCOUNT: optionalText,
    // Loopback only: the emulator accepts any caller as the owner, so it must never be remote.
    FIRESTORE_EMULATOR_HOST: optionalText.refine(
      (value) => value === undefined || /^(127\.0\.0\.1|localhost):\d{2,5}$/.test(value),
      "must be a loopback host:port",
    ),
  })
  .superRefine((value, context) => {
    const deployed = value.ENVIRONMENT === "staging" || value.ENVIRONMENT === "production";
    if (deployed && value.FIRESTORE_EMULATOR_HOST !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["FIRESTORE_EMULATOR_HOST"],
        message: "must not be set in a deployed environment",
      });
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
    FIRESTORE_EMULATOR_HOST: env.FIRESTORE_EMULATOR_HOST,
  });
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`),
    );
  }
  return {
    environment: parsed.data.ENVIRONMENT,
    firebaseProjectId: parsed.data.FIREBASE_PROJECT_ID,
    serviceAccountJson: parsed.data.FIREBASE_SERVICE_ACCOUNT,
    firestoreEmulatorHost: parsed.data.FIRESTORE_EMULATOR_HOST,
  };
}
