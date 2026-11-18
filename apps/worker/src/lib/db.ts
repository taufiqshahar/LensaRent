/**
 * Small helpers around Cloudflare D1.
 *
 * `db.batch([...])` runs its statements as ONE SQL transaction: if any statement fails,
 * every statement in the batch is rolled back. That is what the booking locks, the
 * audited updates and the rate limits rely on. Note the one trap: an UPDATE or DELETE
 * that matches no rows is not a failure, so the batch still commits; statements that must
 * only apply together are guarded in SQL (see routes/adminLeads.ts).
 */

/** True when D1 refused a write because a PRIMARY KEY or UNIQUE value already exists. */
export function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    /UNIQUE constraint failed|PRIMARY KEY constraint failed/i.test(
      `${error.message} ${error.cause instanceof Error ? error.cause.message : ""}`,
    )
  );
}

/** `?, ?, ?` for an IN (...) list of `count` values. */
export function placeholders(count: number): string {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error("Need at least one value");
  return Array.from({ length: count }, () => "?").join(", ");
}

const ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** A random 20-character id (about 119 bits). */
export function newId(): string {
  // 248 is the largest multiple of 62 below 256; rejecting bytes above it keeps ids uniform.
  const id: string[] = [];
  while (id.length < 20) {
    for (const byte of crypto.getRandomValues(new Uint8Array(32))) {
      if (byte < 248 && id.length < 20) id.push(ID_ALPHABET.charAt(byte % 62));
    }
  }
  return id.join("");
}
