/**
 * The status-page token is kept in this browser only (localStorage), so the customer can
 * come back to /tempahan after paying. It is never put in a URL the server sees: emails
 * carry it in the fragment (#t=…), which browsers do not send.
 */
const PREFIX = "lensarent:booking:";
const REF = /^PK-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/;
const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;

export function rememberBooking(ref: string, token: string): void {
  if (!REF.test(ref) || !TOKEN.test(token)) return;
  try {
    localStorage.setItem(PREFIX + ref, token);
  } catch {
    // Private mode or storage disabled: the emailed link still works.
  }
}

export function recallBooking(ref: string): string | null {
  if (!REF.test(ref)) return null;
  try {
    const token = localStorage.getItem(PREFIX + ref);
    return token && TOKEN.test(token) ? token : null;
  } catch {
    return null;
  }
}

export function isRefCode(value: string): boolean {
  return REF.test(value);
}

export function isToken(value: string): boolean {
  return TOKEN.test(value);
}
