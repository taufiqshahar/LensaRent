/**
 * Structured JSON logger with redaction (master prompt §8).
 *
 * Logs must never contain a name, phone number, email, IC digits or any token. Identify
 * records by `bookingId` / `refCode` only. Redaction works in two layers, so a mistake in
 * one is still caught by the other:
 *   1. by key  — fields whose name suggests personal or secret data are replaced entirely;
 *   2. by value — every remaining string is scrubbed for emails, phone numbers and tokens.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

export interface LoggerOptions {
  environment: string;
  /** Where finished lines go. Defaults to the console, which Workers Logs captures. */
  sink?: (level: LogLevel, line: string) => void;
  now?: () => Date;
}

const REDACTED = "[REDACTED]";
const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 50;
const MAX_STRING_LENGTH = 2000;

/** Compared against the key lower-cased with punctuation removed. */
const SENSITIVE_EXACT_KEYS: ReadonlySet<string> = new Set([
  "name",
  "customername",
  "fullname",
  "firstname",
  "lastname",
  "legalname",
  "address",
  "toaddress",
  "idlast4",
  "ic",
  "icnumber",
  "mykad",
  "nric",
  "ip",
  "ipaddress",
  "iphash",
  "useragent",
  "cookie",
  "signature",
  "assertion",
  "pepper",
  "notes",
  "note",
  "payload",
  "body",
  "customersnapshot",
  "verification",
]);

const SENSITIVE_KEY_FRAGMENTS = [
  "phone",
  "email",
  "token",
  "secret",
  "password",
  "authorization",
  "privatekey",
  "apikey",
  "whatsapp",
  "serviceaccount",
];

function isSensitiveKey(key: string): boolean {
  const normalised = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    SENSITIVE_EXACT_KEYS.has(normalised) ||
    SENSITIVE_KEY_FRAGMENTS.some((fragment) => normalised.includes(fragment))
  );
}

const VALUE_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    "[PRIVATE_KEY]",
  ],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, "[JWT]"],
  [/\bBearer\s+[^\s"',]+/gi, "Bearer [TOKEN]"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[EMAIL]"],
  // International (+60174913169), wa.me style (60174913169) and local (017-491 3169) numbers.
  [/\+\d{8,15}\b/g, "[PHONE]"],
  [/\b60\d{8,10}\b/g, "[PHONE]"],
  [/\b0\d{1,2}[-\s]?\d{3,4}[-\s]?\d{4}\b/g, "[PHONE]"],
  // Long opaque strings: lookup tokens, API keys, access tokens.
  [/\b[A-Za-z0-9_-]{40,}\b/g, "[TOKEN]"],
];

/** Removes anything that looks like personal data or a credential from free text. */
export function scrubText(text: string): string {
  let scrubbed = text.length > MAX_STRING_LENGTH ? `${text.slice(0, MAX_STRING_LENGTH)}…` : text;
  for (const [pattern, replacement] of VALUE_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, replacement);
  }
  return scrubbed;
}

function redactError(
  error: Error,
  includeStack: boolean,
  depth: number,
  seen: WeakSet<object>,
): LogFields {
  const details: LogFields = { name: error.name, message: scrubText(error.message) };
  if ("code" in error && typeof error.code === "string") details.code = error.code;
  if ("httpStatus" in error && typeof error.httpStatus === "number") {
    details.httpStatus = error.httpStatus;
  }
  if (includeStack && error.stack) details.stack = scrubText(error.stack);
  if (error.cause !== undefined) {
    details.cause = redactValue(error.cause, includeStack, depth + 1, seen);
  }
  return details;
}

function redactValue(
  value: unknown,
  includeStack: boolean,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case "string":
      return scrubText(value);
    case "number":
      return Number.isFinite(value) ? value : String(value);
    case "boolean":
      return value;
    case "bigint":
      return value.toString();
    case "object":
      break;
    default:
      return `[${typeof value}]`;
  }

  if (depth >= MAX_DEPTH) return "[TRUNCATED]";
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);

  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? "[INVALID_DATE]" : value.toISOString();
  if (value instanceof Error) return redactError(value, includeStack, depth, seen);
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => redactValue(item, includeStack, depth + 1, seen));
  }

  const result: LogFields = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = isSensitiveKey(key)
      ? REDACTED
      : redactValue(entry, includeStack, depth + 1, seen);
  }
  return result;
}

/** Returns a copy of `fields` that is safe to log. */
export function redact(fields: LogFields, options: { includeStack?: boolean } = {}): LogFields {
  return redactValue(fields, options.includeStack ?? false, 0, new WeakSet()) as LogFields;
}

function consoleSink(level: LogLevel, line: string): void {
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export function createLogger(options: LoggerOptions): Logger {
  const sink = options.sink ?? consoleSink;
  const now = options.now ?? (() => new Date());
  // Stack traces help locally but are noise (and a small information leak) once deployed.
  const includeStack = options.environment === "development" || options.environment === "test";

  const write = (level: LogLevel, event: string, fields: LogFields = {}): void => {
    sink(
      level,
      JSON.stringify({
        ...redact(fields, { includeStack }),
        level,
        time: now().toISOString(),
        environment: options.environment,
        event,
      }),
    );
  };

  return {
    debug: (event, fields) => {
      write("debug", event, fields);
    },
    info: (event, fields) => {
      write("info", event, fields);
    },
    warn: (event, fields) => {
      write("warn", event, fields);
    },
    error: (event, fields) => {
      write("error", event, fields);
    },
  };
}
