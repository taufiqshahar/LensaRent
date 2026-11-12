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
  VALIDATION_FAILED: { status: 400, message: "Sila semak maklumat yang diisi." },
  INVALID_JSON: { status: 400, message: "Permintaan tidak sah." },
  UNAUTHENTICATED: { status: 401, message: "Sila log masuk." },
  LOGIN_FAILED: { status: 401, message: "Emel atau kata laluan salah." },
  TURNSTILE_FAILED: {
    status: 403,
    message: "Pengesahan keselamatan gagal. Sila muat semula halaman dan cuba lagi.",
  },
  FORBIDDEN_ORIGIN: { status: 403, message: "Permintaan ditolak." },
  NOT_FOUND: { status: 404, message: "Halaman atau sumber tidak dijumpai." },
  METHOD_NOT_ALLOWED: { status: 405, message: "Kaedah permintaan tidak dibenarkan." },
  PAYLOAD_TOO_LARGE: { status: 413, message: "Permintaan terlalu besar." },
  UNSUPPORTED_MEDIA_TYPE: { status: 415, message: "Jenis kandungan tidak disokong." },
  RATE_LIMITED: { status: 429, message: "Terlalu banyak cubaan. Sila cuba sebentar lagi." },
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

/** 400 with a Bahasa Melayu message per invalid field, keyed by field name. */
export function validationErrorResponse(fields: Readonly<Record<string, string>>): Response {
  const { status, message } = API_ERRORS.VALIDATION_FAILED;
  return jsonResponse({ error: { code: "VALIDATION_FAILED", message, fields } }, status);
}

export function rateLimitedResponse(retryAfterSeconds: number): Response {
  return errorResponse("RATE_LIMITED", { "Retry-After": retryAfterSeconds.toString() });
}

/** Largest JSON body any endpoint accepts. Forms here are a few hundred bytes. */
export const MAX_JSON_BYTES = 16 * 1024;

export type JsonBody = { ok: true; value: unknown } | { ok: false; response: Response };

/**
 * Reads a JSON request body, refusing other content types and anything over `maxBytes`
 * without buffering more than that.
 */
export async function readJson(request: Request, maxBytes = MAX_JSON_BYTES): Promise<JsonBody> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json(\s*;|$)/i.test(type)) {
    return { ok: false, response: errorResponse("UNSUPPORTED_MEDIA_TYPE") };
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > maxBytes) return { ok: false, response: errorResponse("PAYLOAD_TOO_LARGE") };
  if (!request.body) return { ok: false, response: errorResponse("INVALID_JSON") };

  const reader = request.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return { ok: false, response: errorResponse("PAYLOAD_TOO_LARGE") };
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) as unknown };
  } catch {
    return { ok: false, response: errorResponse("INVALID_JSON") };
  }
}

/** The visitor's IP as Cloudflare saw it. Absent only outside Cloudflare (local tools). */
export function clientIp(request: Request): string | undefined {
  return request.headers.get("cf-connecting-ip") ?? undefined;
}

/**
 * CSRF guard for cookie-authenticated requests that change state: the browser must say
 * the request comes from our own origin. Combined with SameSite=Strict cookies and a
 * JSON-only body, a cross-site form or script cannot act as the admin.
 */
export function isSameOrigin(request: Request, url: URL): boolean {
  return request.headers.get("origin") === url.origin;
}
