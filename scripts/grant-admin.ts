/**
 * Grants or revokes the `admin` custom claim on a Firebase Auth account.
 *
 * This is the ONLY way an account becomes an admin: there is no sign-up endpoint. Create
 * the account (email + strong password) in the Firebase Console first, then:
 *
 *   pnpm grant-admin --project lensarent-staging --email you@example.com --key sa.json
 *   pnpm grant-admin --project lensarent-staging --email you@example.com --key sa.json --revoke
 *
 * Revoking also deletes the account's live admin sessions, so it takes effect at once.
 * Against the local emulators, set FIREBASE_AUTH_EMULATOR_HOST and FIRESTORE_EMULATOR_HOST
 * and omit --key.
 *
 * Runs on Node 22.18+ directly (type stripping); no build step.
 */
import { readFileSync } from "node:fs";
import { argv, env, exit } from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { AccessTokenProvider } from "../apps/worker/src/lib/googleAuth.ts";
import {
  EmulatorTokenProvider,
  ServiceAccountTokenProvider,
  parseServiceAccount,
} from "../apps/worker/src/lib/googleAuth.ts";
import type { AdminOptions } from "../apps/worker/src/lib/identityToolkit.ts";
import { lookupUserByEmail, setCustomClaims } from "../apps/worker/src/lib/identityToolkit.ts";

const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

export interface GrantOptions {
  projectId: string;
  email: string;
  revoke: boolean;
  tokenProvider: AccessTokenProvider;
  authEmulatorHost?: string | undefined;
  firestoreEmulatorHost?: string | undefined;
}

export interface GrantResult {
  uid: string;
  admin: boolean;
  sessionsEnded: number;
}

/** Deletes every admin session of `uid` with the Firestore REST API. */
async function endSessions(options: GrantOptions, uid: string): Promise<number> {
  const origin = options.firestoreEmulatorHost
    ? `http://${options.firestoreEmulatorHost}`
    : "https://firestore.googleapis.com";
  const root = `projects/${options.projectId}/databases/(default)/documents`;
  const headers = {
    authorization: `Bearer ${await options.tokenProvider.getToken()}`,
    "content-type": "application/json",
  };

  const query = await fetch(`${origin}/v1/${root}:runQuery`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: "adminSessions" }],
        where: {
          fieldFilter: { field: { fieldPath: "uid" }, op: "EQUAL", value: { stringValue: uid } },
        },
        limit: 500,
      },
    }),
  });
  if (!query.ok) throw new Error(`Could not list sessions (HTTP ${query.status.toString()})`);
  const rows = (await query.json()) as { document?: { name: string } }[];
  const names = rows.flatMap((row) => (row.document ? [row.document.name] : []));
  if (names.length === 0) return 0;

  const commit = await fetch(`${origin}/v1/${root}:commit`, {
    method: "POST",
    headers,
    body: JSON.stringify({ writes: names.map((name) => ({ delete: name })) }),
  });
  if (!commit.ok) throw new Error(`Could not end sessions (HTTP ${commit.status.toString()})`);
  return names.length;
}

export async function grantAdmin(options: GrantOptions): Promise<GrantResult> {
  const admin: AdminOptions = {
    apiKey: "unused",
    emulatorHost: options.authEmulatorHost,
    projectId: options.projectId,
    tokenProvider: options.tokenProvider,
  };
  const user = await lookupUserByEmail(admin, options.email.trim().toLowerCase());
  if (!user) {
    throw new Error("No account with that email. Create it in the Firebase Console first.");
  }

  const claims = { ...user.customClaims };
  if (options.revoke) delete claims.admin;
  else claims.admin = true;
  await setCustomClaims(admin, user.uid, claims);

  const sessionsEnded = options.revoke ? await endSessions(options, user.uid) : 0;
  return { uid: user.uid, admin: !options.revoke, sessionsEnded };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      project: { type: "string" },
      email: { type: "string" },
      key: { type: "string" },
      revoke: { type: "boolean", default: false },
    },
  });
  if (!values.project || !values.email) {
    console.error("Usage: grant-admin --project <id> --email <email> [--key <sa.json>] [--revoke]");
    exit(2);
  }

  const authEmulatorHost = env.FIREBASE_AUTH_EMULATOR_HOST;
  const firestoreEmulatorHost = env.FIRESTORE_EMULATOR_HOST;
  const usingEmulators = authEmulatorHost !== undefined;
  const keyPath = values.key ?? env.GOOGLE_APPLICATION_CREDENTIALS;
  let tokenProvider: AccessTokenProvider;
  if (usingEmulators) {
    tokenProvider = new EmulatorTokenProvider();
  } else if (keyPath) {
    tokenProvider = new ServiceAccountTokenProvider(
      parseServiceAccount(readFileSync(keyPath, "utf8")),
      [CLOUD_PLATFORM_SCOPE],
    );
  } else {
    console.error("Pass --key <service-account.json> (or set GOOGLE_APPLICATION_CREDENTIALS).");
    exit(2);
  }

  const result = await grantAdmin({
    projectId: values.project,
    email: values.email,
    revoke: values.revoke,
    tokenProvider,
    authEmulatorHost,
    firestoreEmulatorHost,
  });
  console.log(
    result.admin
      ? `Admin granted (uid ${result.uid}). It applies from the account's next sign-in.`
      : `Admin revoked (uid ${result.uid}); ${result.sessionsEnded.toString()} session(s) ended.`,
  );
}

if (argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "grant-admin failed");
    exit(1);
  });
}
