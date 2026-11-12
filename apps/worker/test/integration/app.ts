import { createApp } from "../../src/app";
import type { Env } from "../../src/lib/env";
import type { TurnstileCheck } from "../../src/lib/turnstile";
import type { Services } from "../../src/services";
import { createServices } from "../../src/services";
import { TEST_ENV } from "../helpers";

/** Turnstile stand-in: the token "pass" is human, anything else is not. */
export const turnstileChecks: TurnstileCheck[] = [];

export function testApp(overrides: Partial<Services> = {}) {
  return createApp((config, env) => ({
    ...createServices(config, env),
    turnstile: {
      verify: (check) => {
        turnstileChecks.push(check);
        return Promise.resolve(check.token === "pass");
      },
    },
    ...overrides,
  }));
}

export const ORIGIN = "https://lensarent.test";

export function call(
  app: ReturnType<typeof createApp>,
  path: string,
  init: RequestInit = {},
  env: Env = TEST_ENV,
): Promise<Response> {
  return app.fetch(new Request(`${ORIGIN}${path}`, init), env);
}

export function jsonInit(
  method: string,
  body: unknown,
  headers: Record<string, string> = {},
): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
    body: JSON.stringify(body),
  };
}

/** A random documentation-range IP, so tests do not share rate-limit buckets. */
export function randomIp(): string {
  const byte = () => Math.floor(Math.random() * 254 + 1).toString();
  return `198.51.${byte()}.${byte()}`;
}

/** A random, valid Malaysian mobile number. */
export function randomPhone(): string {
  return `01${Math.floor(Math.random() * 9 + 2).toString()}${Math.floor(Math.random() * 1e7)
    .toString()
    .padStart(7, "0")}`;
}
