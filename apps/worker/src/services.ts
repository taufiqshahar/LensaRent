import type { AppConfig, Env } from "./lib/env";
import type { Firestore } from "./lib/firestore";
import { createFirestore } from "./lib/firestore";
import type { Hasher } from "./lib/crypto";
import { createHasher } from "./lib/crypto";
import type { IdTokenVerifier } from "./lib/idToken";
import { createEmulatorIdTokenVerifier, createIdTokenVerifier } from "./lib/idToken";
import type { SignInResult } from "./lib/identityToolkit";
import { signInWithPassword } from "./lib/identityToolkit";
import type { TurnstileVerifier } from "./lib/turnstile";
import { createTurnstileVerifier } from "./lib/turnstile";

/**
 * Everything a handler talks to outside its own code. Built once per request from
 * validated configuration; tests replace individual services (e.g. Turnstile) and keep
 * the rest real.
 */
export interface Services {
  db: Firestore;
  turnstile: TurnstileVerifier;
  hasher: Hasher;
  signIn(email: string, password: string): Promise<SignInResult>;
  idTokens: IdTokenVerifier;
  /** Optional first line against floods; the real limits are in Firestore. */
  burstLimiter: RateLimit | undefined;
  now(): Date;
}

export function createServices(config: AppConfig, env: Env): Services {
  const identity = {
    apiKey: config.firebaseApiKey,
    emulatorHost: config.authEmulatorHost,
  };
  return {
    db: createFirestore(config),
    turnstile: createTurnstileVerifier({
      secretKey: config.turnstileSecretKey,
      strict: config.deployed,
    }),
    hasher: createHasher(config.phoneHashPepper),
    signIn: (email, password) => signInWithPassword(identity, email, password),
    idTokens:
      config.authEmulatorHost === undefined
        ? createIdTokenVerifier({ projectId: config.firebaseProjectId })
        : createEmulatorIdTokenVerifier({ projectId: config.firebaseProjectId }),
    burstLimiter: env.RL_BURST,
    now: () => new Date(),
  };
}

export type ServicesFactory = (config: AppConfig, env: Env) => Services;
