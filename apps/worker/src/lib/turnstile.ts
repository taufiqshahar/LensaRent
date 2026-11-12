import { z } from "zod";

/**
 * Cloudflare Turnstile server-side check. A token proves a human (probably) solved the
 * widget on our page moments ago; each token can be redeemed once.
 */
export const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TIMEOUT_MS = 8_000;

export interface TurnstileCheck {
  token: string;
  remoteIp: string | undefined;
  /** The `action` the widget was rendered with, e.g. `lead`. */
  expectedAction: string;
  /** Our own hostname; a token issued for another site is refused. */
  expectedHostname: string;
}

export interface TurnstileVerifier {
  verify(check: TurnstileCheck): Promise<boolean>;
}

const responseSchema = z.object({
  success: z.boolean(),
  hostname: z.string().optional(),
  action: z.string().optional(),
});

export interface TurnstileOptions {
  secretKey: string;
  /**
   * Check that the token was issued for our hostname and action. On in staging and
   * production; off locally, where Cloudflare's test keys answer for a dummy hostname.
   */
  strict: boolean;
  fetch?: typeof fetch;
}

export function createTurnstileVerifier(options: TurnstileOptions): TurnstileVerifier {
  const fetcher = options.fetch ?? ((input, init) => fetch(input, init));
  return {
    async verify(check) {
      const body = new URLSearchParams({ secret: options.secretKey, response: check.token });
      if (check.remoteIp) body.set("remoteip", check.remoteIp);

      const response = await fetcher(TURNSTILE_VERIFY_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Turnstile verification failed (HTTP ${response.status.toString()})`);
      }

      const parsed = responseSchema.safeParse(await response.json().catch(() => undefined));
      if (!parsed.success) throw new Error("Turnstile response was not understood");

      const { success, hostname, action } = parsed.data;
      if (!success) return false;
      if (!options.strict) return true;
      return hostname === check.expectedHostname && action === check.expectedAction;
    },
  };
}
