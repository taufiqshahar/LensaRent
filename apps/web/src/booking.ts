import { formatRM } from "@lensarent/shared/money";
import type { HandoverSlot } from "@lensarent/shared/slots";
import { slotsOn } from "@lensarent/shared/slots";
import { addDays } from "@lensarent/shared/time";
import type { ApiError } from "./dom";
import { NETWORK_ERROR, apiError, byId, el } from "./dom";
import { rememberBooking } from "./bookingStore";
import { turnstileWidget } from "./turnstile";

/**
 * /tempah — the booking form. The server decides everything that matters (slots, price,
 * availability); this script only collects choices, shows the server's quote, and hands
 * the customer to CHIP's checkout.
 */
interface Config {
  bookingOpen: boolean;
  today: string;
  maxDaysAhead: number;
  minLeadHours: number;
  maxRentalDays: number;
  holdMinutes: number;
  slots: HandoverSlot[];
}

interface Quote {
  available: boolean;
  rentalDays: number;
  breakdown: {
    rentalSen: number;
    addOnsSen: number;
    meetupSen: number;
    depositSen: number;
    totalPayableSen: number;
  };
}

const FIELDS = [
  "pickupDate",
  "pickupSlotId",
  "pickupLocationId",
  "returnDate",
  "returnSlotId",
  "returnLocationId",
  "addOns",
  "name",
  "phone",
  "email",
  "consent",
  "turnstileToken",
] as const;

function rm(sen: number): string {
  return formatRM(sen).replace(/\.00$/, "");
}

function value(form: HTMLFormElement, name: string): string {
  const field = new FormData(form).get(name);
  return typeof field === "string" ? field : "";
}

async function postJson(path: string, body: unknown): Promise<Response | null> {
  try {
    return await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return null;
  }
}

function setup(config: Config): void {
  const form = byId("booking-form", HTMLFormElement);
  const status = byId("booking-status", HTMLElement);
  const container = byId("turnstile", HTMLElement);
  const quoteStatus = byId("quote-status", HTMLElement);
  const quoteLines = byId("quote-lines", HTMLElement);
  if (!form || !status || !container || !quoteStatus || !quoteLines) return;
  form.hidden = false;
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');

  const setStatus = (message: string, kind: "ok" | "error" | "") => {
    status.textContent = message;
    status.dataset.kind = kind;
  };
  const showErrors = (fields: Record<string, string>) => {
    let first: HTMLElement | null = null;
    for (const field of FIELDS) {
      const message = fields[field];
      const node = byId(`${field}-error`, HTMLElement);
      if (node) {
        node.textContent = message ?? "";
        node.hidden = !message;
      }
      const input = byId(field, HTMLElement);
      input?.setAttribute("aria-invalid", message ? "true" : "false");
      if (message && !first) first = input;
    }
    if (fields._form) setStatus(fields._form, "error");
    first?.focus();
  };

  // Dates: from today to the booking horizon.
  const last = addDays(config.today, config.maxDaysAhead);
  for (const kind of ["pickup", "return"] as const) {
    const date = byId(`${kind}Date`, HTMLInputElement);
    if (date) {
      date.min = config.today;
      date.max = kind === "pickup" ? last : addDays(last, config.maxRentalDays);
    }
  }

  // Slots depend on the day of the week; refill the list whenever a date changes.
  const fillSlots = (kind: "pickup" | "return") => {
    const date = byId(`${kind}Date`, HTMLInputElement);
    const select = byId(`${kind}SlotId`, HTMLSelectElement);
    if (!date || !select) return;
    const previous = select.value;
    const offered = /^\d{4}-\d{2}-\d{2}$/.test(date.value)
      ? slotsOn(config.slots, date.value, kind)
      : [];
    select.replaceChildren(
      el(
        "option",
        { value: "" },
        date.value === ""
          ? "Pilih tarikh dahulu"
          : offered.length === 0
            ? "Tiada slot pada hari ini"
            : "Pilih slot",
      ),
      ...offered.map((slot) =>
        el(
          "option",
          { value: slot.id, selected: slot.id === previous },
          `${slot.label} (${slot.startTime}–${slot.endTime})`,
        ),
      ),
    );
  };

  const period = () => ({
    pickupDate: value(form, "pickupDate"),
    pickupSlotId: value(form, "pickupSlotId"),
    pickupLocationId: value(form, "pickupLocationId"),
    returnDate: value(form, "returnDate"),
    returnSlotId: value(form, "returnSlotId"),
    returnLocationId: value(form, "returnLocationId"),
    addOns: new FormData(form)
      .getAll("addon")
      .filter((code): code is string => typeof code === "string")
      .map((code) => ({ code, qty: 1 })),
  });

  // Ask the server for the price whenever the period changes; ignore stale answers.
  let quoteSeq = 0;
  const refreshQuote = () => {
    const current = period();
    if (!current.pickupSlotId || !current.returnSlotId) {
      quoteLines.hidden = true;
      quoteStatus.textContent = "Pilih tarikh dan slot untuk melihat harga.";
      return;
    }
    const seq = ++quoteSeq;
    quoteStatus.textContent = "Mengira…";
    void postJson("/api/quote", current).then(async (response) => {
      if (seq !== quoteSeq) return;
      if (!response?.ok) {
        const error = response ? await apiError(response) : NETWORK_ERROR;
        quoteLines.hidden = true;
        quoteStatus.textContent = Object.values(error.fields ?? {})[0] ?? error.message;
        return;
      }
      const quote = (await response.json()) as Quote;
      if (seq !== quoteSeq) return;
      const set = (name: string, sen: number) => {
        const node = quoteLines.querySelector<HTMLElement>(`[data-out="${name}"]`);
        if (node) node.textContent = rm(sen);
      };
      set("rental", quote.breakdown.rentalSen);
      set("addons", quote.breakdown.addOnsSen);
      set("meetup", quote.breakdown.meetupSen);
      set("deposit", quote.breakdown.depositSen);
      set("total", quote.breakdown.totalPayableSen);
      quoteLines.hidden = false;
      quoteStatus.textContent = quote.available
        ? `${quote.rentalDays.toString()} hari sewaan. Tarikh ini masih kosong.`
        : "Maaf, tarikh ini sudah penuh. Sila pilih tarikh atau slot lain.";
      quoteStatus.dataset.kind = quote.available ? "ok" : "error";
    });
  };

  form.addEventListener("change", (event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement && target.id === "pickupDate") {
      fillSlots("pickup");
      const ret = byId("returnDate", HTMLInputElement);
      if (ret && (ret.value === "" || ret.value < target.value)) {
        ret.value = addDays(target.value, 1);
        fillSlots("return");
      }
    }
    if (target instanceof HTMLInputElement && target.id === "returnDate") fillSlots("return");
    refreshQuote();
  });

  const turnstile = turnstileWidget(container, form.dataset.sitekey ?? "", "booking", () => {
    setStatus("Pengesahan keselamatan tidak dapat dimuatkan. Sila muat semula halaman.", "error");
  });
  form.addEventListener(
    "focusin",
    () => {
      turnstile.start();
    },
    { once: true },
  );

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    turnstile.start();
    const token = turnstile.token();
    if (!token) {
      showErrors({ turnstileToken: "Sila tunggu pengesahan keselamatan selesai." });
      return;
    }
    const consent = byId("consent", HTMLInputElement)?.checked === true;
    const body = {
      ...period(),
      name: value(form, "name"),
      phone: value(form, "phone"),
      email: value(form, "email"),
      consent: { terms: consent, privacy: consent },
      turnstileToken: token,
    };
    if (submit) submit.disabled = true;
    setStatus("Menahan tarikh anda…", "");
    void postJson("/api/bookings/hold", body).then(async (response) => {
      turnstile.reset();
      if (response?.ok) {
        const hold = (await response.json()) as {
          refCode: string;
          lookupToken: string;
          checkoutUrl: string;
        };
        rememberBooking(hold.refCode, hold.lookupToken);
        setStatus(`Tarikh ditahan (${hold.refCode}). Membawa anda ke halaman bayaran…`, "ok");
        window.location.assign(hold.checkoutUrl);
        return;
      }
      if (submit) submit.disabled = false;
      const error: ApiError = response ? await apiError(response) : NETWORK_ERROR;
      showErrors(error.fields ?? {});
      setStatus(error.message, "error");
      if (error.code === "SLOT_UNAVAILABLE") refreshQuote();
    });
  });
}

void fetch("/api/config")
  .then(async (response) => (response.ok ? ((await response.json()) as Config) : null))
  .catch(() => null)
  .then((config) => {
    if (config?.bookingOpen) setup(config);
    else {
      const closed = byId("booking-closed", HTMLElement);
      if (closed) closed.hidden = false;
    }
  });
