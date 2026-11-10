/**
 * Every piece of text the customer sees, in Bahasa Melayu (required by CPETTR 2024).
 * HTML pages reference these as {{t:key}} and Vite substitutes them at build time, so the
 * pages stay static while the wording lives in one place, ready for another language.
 */
export const strings = {
  "site.name": "LensaRent",

  "placeholder.title": "LensaRent — Sewa DJI Osmo Pocket 4P",
  "placeholder.description":
    "Sewa kamera DJI Osmo Pocket 4P di Parit Buntar, Bandar Baharu dan Nibong Tebal.",
  "placeholder.heading": "Sewa DJI Osmo Pocket 4P",
  "placeholder.body": "Laman ini sedang dibina. Kami akan dibuka tidak lama lagi.",
  "placeholder.area": "Parit Buntar · Bandar Baharu · Nibong Tebal",

  "notFound.title": "Halaman tidak dijumpai — LensaRent",
  "notFound.heading": "Halaman tidak dijumpai",
  "notFound.body": "Pautan ini mungkin salah atau telah dialihkan.",
  "notFound.home": "Kembali ke laman utama",
} as const;

export type StringKey = keyof typeof strings;

export function t(key: StringKey): string {
  return strings[key];
}

export function isStringKey(key: string): key is StringKey {
  return Object.hasOwn(strings, key);
}
