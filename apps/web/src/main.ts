import { DEFAULT_SETTINGS } from "@lensarent/shared/defaultSettings";
import { formatRM } from "@lensarent/shared/money";
import { quote } from "@lensarent/shared/pricing";
import { mytDateString } from "@lensarent/shared/time";
import type { ApiError } from "./dom";
import { NETWORK_ERROR, apiError, byId } from "./dom";

/**
 * Landing page behaviour: the price calculator and the interest form. The page is fully
 * readable without this script; only the two interactive pieces need it.
 */

function rm(sen: number): string {
  return formatRM(sen).replace(/\.00$/, "");
}

// ── Price calculator ─────────────────────────────────────────────────────────────────────
// Uses the same quote() and the same settings as the server, so the estimate matches.

function setupCalculator(): void {
  const form = byId("kalkulator", HTMLFormElement);
  if (!form) return;
  const out = (name: string) => form.querySelector<HTMLElement>(`[data-out="${name}"]`);

  const update = () => {
    const data = new FormData(form);
    const result = quote(
      {
        rentalDays: Number(data.get("days")),
        addOns: data
          .getAll("addon")
          .filter((code): code is string => typeof code === "string")
          .map((code) => ({ code, qty: 1 })),
        pickupLocationId: DEFAULT_SETTINGS.meetupLocations.locations[0]?.id ?? "",
        returnLocationId: DEFAULT_SETTINGS.meetupLocations.locations[0]?.id ?? "",
        customerTier: "new",
      },
      DEFAULT_SETTINGS,
    );
    const { rentalSen, addOnsSen, meetupSen, depositSen, totalPayableSen } = result.breakdown;
    const set = (name: string, sen: number) => {
      const node = out(name);
      if (node) node.textContent = rm(sen);
    };
    set("rental", rentalSen);
    set("addons", addOnsSen);
    set("charges", rentalSen + addOnsSen + meetupSen);
    set("deposit", depositSen);
    set("total", totalPayableSen);
  };

  form.addEventListener("change", update);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
  });
  update();
}

// ── Turnstile ────────────────────────────────────────────────────────────────────────────
// Loaded only when the visitor starts filling in the form, to keep the first load fast.

interface TurnstileApi {
  render(container: HTMLElement, options: Record<string, unknown>): string;
  reset(widgetId?: string): void;
}
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const TURNSTILE_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let turnstileLoading: Promise<TurnstileApi> | undefined;

function loadTurnstile(): Promise<TurnstileApi> {
  turnstileLoading ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = TURNSTILE_SRC;
    script.async = true;
    script.onload = () => {
      if (window.turnstile) resolve(window.turnstile);
      else reject(new Error("Turnstile did not load"));
    };
    script.onerror = () => {
      turnstileLoading = undefined;
      reject(new Error("Turnstile did not load"));
    };
    document.head.append(script);
  });
  return turnstileLoading;
}

// ── Interest form ────────────────────────────────────────────────────────────────────────

function text(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === "string" ? value : "";
}

const FIELDS = ["name", "phone", "desiredDate", "usage", "source", "consent", "turnstileToken"];

function setupLeadForm(): void {
  const form = byId("lead-form", HTMLFormElement);
  const status = byId("lead-status", HTMLElement);
  const container = byId("turnstile", HTMLElement);
  if (!form || !status || !container) return;
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');

  const date = byId("desiredDate", HTMLInputElement);
  if (date) date.min = mytDateString(new Date());

  let token = "";
  let widgetId: string | undefined;

  const showErrors = (fields: Record<string, string>) => {
    let first: HTMLElement | null = null;
    for (const field of FIELDS) {
      const message = fields[field];
      const node = byId(`${field}-error`, HTMLElement);
      const input = byId(field, HTMLElement);
      if (node) {
        node.textContent = message ?? "";
        node.hidden = !message;
      }
      input?.setAttribute("aria-invalid", message ? "true" : "false");
      if (message && !first) first = input;
    }
    first?.focus();
  };

  const setStatus = (message: string, kind: "ok" | "error" | "") => {
    status.textContent = message;
    status.dataset.kind = kind;
  };

  const startTurnstile = () => {
    if (widgetId !== undefined) return;
    widgetId = "pending";
    loadTurnstile()
      .then((turnstile) => {
        widgetId = turnstile.render(container, {
          sitekey: form.dataset.sitekey,
          action: "lead",
          language: "ms",
          callback: (value: string) => {
            token = value;
          },
          "expired-callback": () => {
            token = "";
          },
          "error-callback": () => {
            token = "";
          },
        });
      })
      .catch(() => {
        widgetId = undefined;
        setStatus(
          "Pengesahan keselamatan tidak dapat dimuatkan. Sila muat semula halaman.",
          "error",
        );
      });
  };
  form.addEventListener("focusin", startTurnstile, { once: true });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    startTurnstile();
    const data = new FormData(form);
    const body = {
      name: text(data, "name"),
      phone: text(data, "phone"),
      desiredDate: text(data, "desiredDate"),
      usage: text(data, "usage"),
      source: text(data, "source"),
      consent: data.get("consent") === "on",
      turnstileToken: token,
    };
    if (!token) {
      showErrors({ turnstileToken: "Sila tunggu pengesahan keselamatan selesai." });
      return;
    }

    if (submit) submit.disabled = true;
    setStatus("Menghantar…", "");
    void fetch("/api/leads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
      .then(async (response): Promise<ApiError | null> => (response.ok ? null : apiError(response)))
      .catch((): ApiError => NETWORK_ERROR)
      .then((error) => {
        if (submit) submit.disabled = false;
        if (!error) {
          form.reset();
          showErrors({});
          setStatus(
            "Terima kasih! Kami akan menghubungi anda melalui WhatsApp secepat mungkin.",
            "ok",
          );
        } else {
          showErrors(error.fields ?? {});
          setStatus(error.message, "error");
        }
        // Tokens are single-use: get a fresh one for the next attempt.
        token = "";
        if (widgetId && widgetId !== "pending") window.turnstile?.reset(widgetId);
      });
  });
}

setupCalculator();
setupLeadForm();
