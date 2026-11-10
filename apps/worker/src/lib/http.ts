/**
 * HTTP helpers for the API. Every API response is JSON, is never cached, and carries the
 * security headers below. Static assets get their headers from apps/web/public/_headers.
 */
export const API_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  // API responses are data, not documents: nothing may be loaded or framed from them.
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "Cache-Control": "no-store",
};

/**
 * Error codes the API can return. The `message` is a generic Bahasa Melayu sentence that
 * is safe to show a customer; it never carries internal detail or a stack trace.
 */
export const API_ERRORS = {
  NOT_FOUND: { status: 404, message: "Halaman atau sumber tidak dijumpai." },
  METHOD_NOT_ALLOWED: { status: 405, message: "Kaedah permintaan tidak dibenarkan." },
  INTERNAL_ERROR: { status: 500, message: "Ralat dalaman. Sila cuba sebentar lagi." },
} as const satisfies Record<string, { status: number; message: string }>;

export type ApiErrorCode = keyof typeof API_ERRORS;

export function jsonResponse(
  body: unknown,
  status = 200,
  extraHeaders: Readonly<Record<string, string>> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...API_SECURITY_HEADERS,
      ...extraHeaders,
    },
  });
}

export function errorResponse(
  code: ApiErrorCode,
  extraHeaders: Readonly<Record<string, string>> = {},
): Response {
  const { status, message } = API_ERRORS[code];
  return jsonResponse({ error: { code, message } }, status, extraHeaders);
}
