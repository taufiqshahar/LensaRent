/**
 * Cloudflare Turnstile, loaded only when a visitor starts filling in a form, to keep the
 * first page load fast. Shared by the interest form and the booking form.
 */
export interface TurnstileApi {
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

export function loadTurnstile(): Promise<TurnstileApi> {
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

/**
 * A widget that renders on first use and keeps the latest token. Tokens are single-use:
 * call `reset()` after every submission.
 */
export function turnstileWidget(
  container: HTMLElement,
  siteKey: string,
  action: string,
  onError: () => void,
): { start(): void; token(): string; reset(): void } {
  let token = "";
  let widgetId: string | undefined;
  return {
    start() {
      if (widgetId !== undefined) return;
      widgetId = "pending";
      loadTurnstile()
        .then((turnstile) => {
          widgetId = turnstile.render(container, {
            sitekey: siteKey,
            action,
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
          onError();
        });
    },
    token: () => token,
    reset() {
      token = "";
      if (widgetId && widgetId !== "pending") window.turnstile?.reset(widgetId);
    },
  };
}
