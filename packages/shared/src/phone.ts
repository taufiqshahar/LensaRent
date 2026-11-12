/**
 * Malaysian mobile numbers. Customers type them in every shape ("017-491 3169",
 * "0174913169", "+60 17 491 3169", "60174913169"); the system stores one: E.164.
 *
 * Only mobile numbers are accepted (01x prefixes): the business contacts customers on
 * WhatsApp, which needs a mobile number.
 */
const MY_MOBILE_E164 = /^\+601\d{8,9}$/;
const SEPARATORS = /[\s\-.()]/g;

/** Returns the number as E.164 (`+60174913169`), or null if it is not a Malaysian mobile. */
export function normalizeMyMobile(input: string): string | null {
  const compact = input.trim().replace(SEPARATORS, "");
  if (!/^\+?\d+$/.test(compact)) return null;

  let e164: string;
  if (compact.startsWith("+")) e164 = compact;
  else if (compact.startsWith("60")) e164 = `+${compact}`;
  else if (compact.startsWith("0")) e164 = `+6${compact}`;
  else return null;

  return MY_MOBILE_E164.test(e164) ? e164 : null;
}

/** Digits only, as `wa.me` expects: `+60174913169` → `60174913169`. */
export function e164Digits(e164: string): string {
  return e164.replace(/^\+/, "");
}

/** Human-readable local format for display: `+60174913169` → `017-491 3169`. */
export function formatMyMobile(e164: string): string {
  if (!MY_MOBILE_E164.test(e164)) return e164;
  // 017-491 3169 (10 digits) or 011-1234 5678 (11 digits): prefix, middle, last four.
  const local = `0${e164.slice(3)}`;
  const prefix = local.slice(0, 3);
  const rest = local.slice(3);
  const split = rest.length - 4;
  return `${prefix}-${rest.slice(0, split)} ${rest.slice(split)}`;
}

/** A WhatsApp click-to-chat link with a pre-filled message. */
export function whatsappUrl(e164: string, message: string): string {
  return `https://wa.me/${e164Digits(e164)}?text=${encodeURIComponent(message)}`;
}
