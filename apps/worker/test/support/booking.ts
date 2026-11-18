import type { AllSettings } from "@lensarent/shared";
import { DEFAULT_SETTINGS, addDays, mytDateTime } from "@lensarent/shared";
import { createChipProvider } from "../../src/lib/chip";
import type { Services } from "../../src/services";
import { randomPhone, testApp } from "../integration/app";
import type { FakeChip } from "./fakeChip";

/** Two slots every day at every location: 10:00–11:00 and 18:00–19:00. */
export const TEST_SETTINGS: AllSettings = {
  ...DEFAULT_SETTINGS,
  handoverSlots: {
    slots: [
      {
        id: "pagi",
        label: "Pagi",
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
        startTime: "10:00",
        endTime: "11:00",
        kinds: ["pickup", "return"],
        locationIds: ["parit-buntar", "bandar-baharu", "nibong-tebal"],
        active: true,
      },
      {
        id: "petang",
        label: "Petang",
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
        startTime: "18:00",
        endTime: "19:00",
        kinds: ["pickup", "return"],
        locationIds: ["parit-buntar", "bandar-baharu", "nibong-tebal"],
        active: true,
      },
    ],
  },
};

/**
 * A random "today" centuries ahead, so each test has a calendar of its own: tests share
 * one database and one fleet, and must not compete for the same days.
 */
export function randomToday(): string {
  const year = 2100 + Math.floor(Math.random() * 800);
  const day = Math.floor(Math.random() * 360);
  return addDays(`${year.toString()}-01-01`, day);
}

export interface BookingWorld {
  today: string;
  now: Date;
  app: ReturnType<typeof testApp>;
}

export function bookingWorld(
  chip: FakeChip | null,
  overrides: Partial<Services> = {},
): BookingWorld {
  const today = randomToday();
  const now = mytDateTime(today, "08:00");
  const app = testApp({
    payments: chip
      ? createChipProvider({
          secretKey: "test-chip-key",
          brandId: "test-brand",
          publicKeyPem: chip.publicKeyPem,
          fetch: chip.fetch,
        })
      : undefined,
    settings: () => Promise.resolve(TEST_SETTINGS),
    now: () => now,
    ...overrides,
  });
  return { today, now, app };
}

export function period(today: string, startOffset = 2, days = 2) {
  return {
    pickupDate: addDays(today, startOffset),
    pickupSlotId: "pagi",
    pickupLocationId: "parit-buntar",
    returnDate: addDays(today, startOffset + days),
    returnSlotId: "pagi",
    returnLocationId: "nibong-tebal",
    addOns: [{ code: "CPL", qty: 1 }],
  };
}

export function holdBody(today: string, overrides: Record<string, unknown> = {}) {
  return {
    ...period(today),
    name: "Nur Aisyah",
    phone: randomPhone(),
    email: "aisyah@example.com",
    consent: { terms: true, privacy: true },
    turnstileToken: "pass",
    ...overrides,
  };
}
