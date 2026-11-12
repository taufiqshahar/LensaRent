import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EmulatorTokenProvider } from "../../apps/worker/src/lib/googleAuth.ts";
import { grantAdmin } from "../grant-admin.ts";

const AUTH = "127.0.0.1:9099";
const FIRESTORE = "127.0.0.1:8080";
const PROJECT = "demo-lensarent";
const ROOT = `projects/${PROJECT}/databases/(default)/documents`;

async function signUp(): Promise<{ email: string; password: string; uid: string }> {
  const email = `grant-${randomUUID()}@example.com`;
  const password = `pw-${randomUUID()}`;
  const response = await fetch(
    `http://${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-api-key`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  const { localId } = (await response.json()) as { localId: string };
  return { email, password, uid: localId };
}

async function claimsAfterSignIn(
  email: string,
  password: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(
    `http://${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-api-key`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  const { idToken } = (await response.json()) as { idToken: string };
  return JSON.parse(Buffer.from(idToken.split(".")[1]!, "base64url").toString()) as Record<
    string,
    unknown
  >;
}

const base = {
  projectId: PROJECT,
  tokenProvider: new EmulatorTokenProvider(),
  authEmulatorHost: AUTH,
  firestoreEmulatorHost: FIRESTORE,
};

describe("grant-admin", () => {
  it("grants the admin claim, which appears in the next ID token", async () => {
    const user = await signUp();
    expect((await claimsAfterSignIn(user.email, user.password)).admin).toBeUndefined();

    const result = await grantAdmin({ ...base, email: user.email.toUpperCase(), revoke: false });

    expect(result).toEqual({ uid: user.uid, admin: true, sessionsEnded: 0 });
    expect((await claimsAfterSignIn(user.email, user.password)).admin).toBe(true);
  });

  it("revokes the claim and ends the account's sessions, leaving others alone", async () => {
    const user = await signUp();
    await grantAdmin({ ...base, email: user.email, revoke: false });
    const other = `other-${randomUUID()}`;
    const seed = await fetch(`http://${FIRESTORE}/v1/${ROOT}:commit`, {
      method: "POST",
      headers: { authorization: "Bearer owner", "content-type": "application/json" },
      body: JSON.stringify({
        writes: [
          {
            update: {
              name: `${ROOT}/adminSessions/s1-${user.uid}`,
              fields: { uid: { stringValue: user.uid } },
            },
          },
          {
            update: {
              name: `${ROOT}/adminSessions/s2-${user.uid}`,
              fields: { uid: { stringValue: user.uid } },
            },
          },
          {
            update: {
              name: `${ROOT}/adminSessions/${other}`,
              fields: { uid: { stringValue: other } },
            },
          },
        ],
      }),
    });
    expect(seed.ok).toBe(true);

    const result = await grantAdmin({ ...base, email: user.email, revoke: true });

    expect(result).toEqual({ uid: user.uid, admin: false, sessionsEnded: 2 });
    expect((await claimsAfterSignIn(user.email, user.password)).admin).toBeUndefined();
    const kept = await fetch(`http://${FIRESTORE}/v1/${ROOT}/adminSessions/${other}`, {
      headers: { authorization: "Bearer owner" },
    });
    expect(kept.status).toBe(200);
  });

  it("refuses an email with no account", async () => {
    await expect(
      grantAdmin({ ...base, email: `nobody-${randomUUID()}@example.com`, revoke: false }),
    ).rejects.toThrow("Create it in the Firebase Console first");
  });
});
