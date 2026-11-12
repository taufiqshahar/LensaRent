/**
 * Tiny DOM builder. Text always goes in as textContent, so data can never become markup
 * (innerHTML and friends are banned by ESLint in apps/web).
 */
type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Record<string, string | boolean | undefined> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === false) continue;
    element.setAttribute(name, value === true ? "" : value);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    element.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return element;
}

/** The element with this id, if it exists and is of the expected type. */
export function byId<T extends HTMLElement>(id: string, type: new () => T): T | null {
  const element = document.getElementById(id);
  return element instanceof type ? element : null;
}

/** API error shape from the Worker: `{ error: { code, message, fields? } }`. */
export interface ApiError {
  code: string;
  message: string;
  fields?: Record<string, string>;
}

export async function apiError(response: Response): Promise<ApiError> {
  try {
    const body = (await response.json()) as { error?: ApiError };
    if (body.error) return body.error;
  } catch {
    // Not JSON: fall through to a generic message.
  }
  return { code: "UNKNOWN", message: "Ralat tidak dijangka. Sila cuba lagi." };
}

export const NETWORK_ERROR: ApiError = {
  code: "NETWORK",
  message: "Tiada sambungan. Semak internet anda dan cuba lagi.",
};
