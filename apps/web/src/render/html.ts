/**
 * Build-time HTML templating. Every interpolated value is escaped unless it is already
 * `SafeHtml` (the output of another `html` template). Runs in Node during `vite build`,
 * never in the browser.
 */
export class SafeHtml {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
  toString(): string {
    return this.value;
  }
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

type Value = SafeHtml | string | number | boolean | null | undefined | readonly Value[];

function render(value: Value): string {
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return (value as readonly Value[]).map(render).join("");
  if (value === null || value === undefined || value === false || value === true) return "";
  return escapeHtml(String(value));
}

export function html(strings: TemplateStringsArray, ...values: Value[]): SafeHtml {
  let out = strings[0] ?? "";
  values.forEach((value, index) => {
    out += render(value) + (strings[index + 1] ?? "");
  });
  return new SafeHtml(out);
}

/** For trusted, already-escaped markup only (e.g. JSON-LD that was JSON-encoded). */
export function trusted(markup: string): SafeHtml {
  return new SafeHtml(markup);
}
