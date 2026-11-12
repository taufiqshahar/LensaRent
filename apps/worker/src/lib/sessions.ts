import { z } from "zod";
import { randomToken, sha256 } from "./crypto";
import type { Firestore, Write } from "./firestore";
import { createDoc, deleteDoc, updateDoc } from "./firestore";

/**
 * Admin sessions (docs/DECISIONS.md, ADR-013).
 *
 * After a successful sign-in the Worker issues its own session: a random 256-bit token in
 * an HttpOnly, Secure, SameSite=Strict cookie. Firestore stores only the token's SHA-256,
 * so a database leak does not hand out live sessions, and lookups by hash need no
 * constant-time comparison.
 *
 * Sessions are short on purpose (master prompt §8, mitigation (b)): 8 hours at most, and
 * they end after 60 minutes without activity.
 */
export const SESSIONS_COLLECTION = "adminSessions";
export const SESSION_COOKIE = "__Host-lensarent_admin";
export const SESSION_ABSOLUTE_MS = 8 * 60 * 60 * 1000;
export const SESSION_IDLE_MS = 60 * 60 * 1000;
/** Activity extends the idle deadline at most this often, to avoid a write per request. */
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export interface Session {
  id: string;
  uid: string;
  email: string;
  createdAt: Date;
  expiresAt: Date;
  idleExpiresAt: Date;
}

const sessionDocumentSchema = z.object({
  uid: z.string(),
  email: z.string(),
  createdAt: z.date(),
  expiresAt: z.date(),
  idleExpiresAt: z.date(),
});

function sessionPath(id: string): string {
  return `${SESSIONS_COLLECTION}/${id}`;
}

export interface NewSession {
  token: string;
  session: Session;
  /** Commit this, together with anything that must happen atomically with the sign-in. */
  write: Write;
}

export async function newSession(
  admin: { uid: string; email: string },
  ipHash: string,
  now: Date,
): Promise<NewSession> {
  const token = randomToken(32);
  const id = await sha256(token);
  const session: Session = {
    id,
    uid: admin.uid,
    email: admin.email,
    createdAt: now,
    expiresAt: new Date(now.getTime() + SESSION_ABSOLUTE_MS),
    idleExpiresAt: new Date(now.getTime() + SESSION_IDLE_MS),
  };
  const stored = {
    uid: session.uid,
    email: session.email,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    idleExpiresAt: session.idleExpiresAt,
    ipHash,
  };
  return { token, session, write: createDoc(sessionPath(id), stored) };
}

/** The live session for a cookie token, or null. Expired sessions are deleted. */
export async function findSession(
  db: Firestore,
  token: string,
  now: Date,
): Promise<Session | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const id = await sha256(token);
  const snapshot = await db.get(sessionPath(id));
  if (!snapshot.exists) return null;

  const parsed = sessionDocumentSchema.safeParse(snapshot.data);
  const nowMs = now.getTime();
  if (
    !parsed.success ||
    parsed.data.expiresAt.getTime() <= nowMs ||
    parsed.data.idleExpiresAt.getTime() <= nowMs
  ) {
    await db.commit([deleteDoc(sessionPath(id))]);
    return null;
  }

  const session: Session = { id, ...parsed.data };
  const idleTarget = Math.min(nowMs + SESSION_IDLE_MS, session.expiresAt.getTime());
  if (idleTarget - session.idleExpiresAt.getTime() >= TOUCH_INTERVAL_MS) {
    session.idleExpiresAt = new Date(idleTarget);
    // If the session was deleted meanwhile (logout elsewhere), this fails and that is fine.
    await db
      .commit([updateDoc(sessionPath(id), { idleExpiresAt: session.idleExpiresAt })])
      .catch(() => undefined);
  }
  return session;
}

export function endSessionWrite(sessionId: string): Write {
  return deleteDoc(sessionPath(sessionId));
}

export function sessionCookie(token: string): string {
  const maxAge = Math.floor(SESSION_ABSOLUTE_MS / 1000).toString();
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

/** The session token from the request's cookies, if any. */
export function readSessionToken(request: Request): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === SESSION_COOKIE) {
      return part.slice(separator + 1).trim();
    }
  }
  return undefined;
}
