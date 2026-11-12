import type { z } from "zod";

/**
 * Turns zod issues into one Bahasa Melayu message per field. Only the field NAME comes from
 * the issue; the text comes from `messages`, so no raw input is ever echoed back.
 */
export function fieldErrors(
  error: z.ZodError,
  messages: Readonly<Record<string, string>>,
  fallback = "Nilai ini tidak sah.",
): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const field = typeof issue.path[0] === "string" ? issue.path[0] : "";
    const key = Object.hasOwn(messages, field) ? field : "_form";
    fields[key] ??= key === "_form" ? fallback : (messages[field] ?? fallback);
  }
  return fields;
}
