import type { ApiError } from "./dom";
import { NETWORK_ERROR, apiError } from "./dom";

/**
 * Admin API calls. Authentication is the Cloudflare Access cookie, sent automatically on
 * same-origin requests; the browser stores nothing else. A 401 anywhere means the Access
 * session ended, and the shell shows the sign-in-again view.
 */
export type Result<T> = { ok: true; value: T } | { ok: false; error: ApiError; status: number };

let onExpired: () => void = () => undefined;

export function setExpiredHandler(handler: () => void): void {
  onExpired = handler;
}

export async function api<T>(
  path: string,
  init: RequestInit & { contentType?: string } = {},
): Promise<Result<T>> {
  const { contentType, ...rest } = init;
  let response: Response;
  try {
    response = await fetch(path, {
      ...rest,
      credentials: "same-origin",
      headers: rest.body ? { "content-type": contentType ?? "application/json" } : {},
    });
  } catch {
    return { ok: false, error: NETWORK_ERROR, status: 0 };
  }
  if (!response.ok) {
    if (response.status === 401) onExpired();
    return { ok: false, error: await apiError(response), status: response.status };
  }
  const value = (response.status === 204 ? null : await response.json()) as T;
  return { ok: true, value };
}

export function send<T = { ok: true }>(method: string, path: string, body: unknown) {
  return api<T>(path, { method, body: JSON.stringify(body) });
}
