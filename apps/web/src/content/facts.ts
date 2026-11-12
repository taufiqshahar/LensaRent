import { DEFAULT_SETTINGS } from "../render/shared.ts";
import { formatRM } from "../render/shared.ts";
import { formatMyMobile, whatsappUrl } from "../render/shared.ts";

/**
 * Every number shown on the site comes from the settings, through here, so the pages say
 * exactly what the pricing code charges (docs/DECISIONS.md, ADR-015).
 */
export const settings = DEFAULT_SETTINGS;

/** "RM69" for whole ringgit, "RM12.50" otherwise. */
export function rm(sen: number): string {
  return formatRM(sen).replace(/\.00$/, "");
}

export const brand = settings.businessInfo.brandName;
export const phoneDisplay = formatMyMobile(settings.businessInfo.phoneE164);

export const fromPrice = rm(settings.pricing.fixedPrices[0]?.priceSen ?? 0);
export const deposit = rm(settings.depositTiers.new);
export const dailyRate = rm(settings.pricing.dailyRateSen);
export const maxDays = settings.maxRentalDays.days;
export const minLeadHours = settings.minLeadHours.hours;
export const longFrom = settings.pricing.fixedPrices.length + 1;

export const priceRows = [
  ...settings.pricing.fixedPrices.map((entry) => ({
    label: `${entry.days.toString()} hari`,
    price: rm(entry.priceSen),
  })),
  { label: `${longFrom.toString()}–${maxDays.toString()} hari`, price: `${dailyRate} sehari` },
];

export const addOns = settings.addOns.items.filter((item) => item.active);
export const filterBase = settings.addOns.lensFilterBase.name;

export const locations = settings.meetupLocations.locations.filter((location) => location.active);
export const locationNames = locations.map((location) => location.name);
export const meetupFree = locations.every((location) => location.feeSen === 0);

export const cancellation = {
  fullAbove: settings.cancellation.fullRefundAboveHours,
  feeFrom: settings.cancellation.feeWindowFromHours,
  fee: rm(settings.cancellation.feeSen),
};

export const lateFee = {
  grace: settings.lateFee.graceMinutes,
  blockHours: settings.lateFee.blockHours,
  perBlock: rm(settings.lateFee.perBlockSen),
  cap: rm(settings.lateFee.capPer24hSen),
};

export const policyVersions = settings.policyVersions;

export function whatsapp(message: string): string {
  return whatsappUrl(settings.businessInfo.whatsappE164, message);
}

export const whatsappGeneral = whatsapp(
  `Hai ${brand}, saya berminat untuk menyewa DJI Osmo Pocket 4P. Boleh saya tahu tarikh yang masih kosong?`,
);

/** "Parit Buntar, Bandar Baharu dan Nibong Tebal" */
export function listBm(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} dan ${items.at(-1) ?? ""}`;
}
