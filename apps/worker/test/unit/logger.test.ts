import { afterEach, describe, expect, it, vi } from "vitest";
import type { LogLevel } from "../../src/lib/logger";
import { createLogger, redact, scrubText } from "../../src/lib/logger";

/** Personal data and secrets planted in the log calls below. None may reach the output. */
const PLANTED = [
  "Ahmad bin Ali",
  "+60174913169",
  "017-491 3169",
  "0174913169",
  "60174913169",
  "ahmad@example.com",
  "1234",
  "lookup-value-lookup-value-lookup-value-lookup-value",
  "eyJhbGciOiJ9.eyJzdWIiOiJ9.c2lnbg",
  "ya29.super-secret-access-token",
  "Jalan Besar",
  "Pelanggan minta slot awal",
  "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC",
];

function capture(environment = "production") {
  const lines: { level: LogLevel; line: string }[] = [];
  const logger = createLogger({
    environment,
    sink: (level, line) => lines.push({ level, line }),
    now: () => new Date("2026-12-24T12:00:00.000Z"),
  });
  return { logger, lines };
}

describe("logger redaction", () => {
  it("keeps booking identifiers and removes every piece of personal data", () => {
    const { logger, lines } = capture();

    logger.info("booking.hold_created", {
      bookingId: "bk_8f2k1",
      refCode: "PK-7F3K9Q",
      unitId: "unit01",
      status: "pending_payment",
      totalPayableSen: 16900,
      pickupAt: new Date("2026-12-26T01:00:00.000Z"),
      lockedDates: ["2026-12-26", "2026-12-27"],
      name: "Ahmad bin Ali",
      phoneE164: "+60174913169",
      phoneHash: "lookup-value-lookup-value-lookup-value-lookup-value",
      email: "ahmad@example.com",
      idLast4: "1234",
      lookupToken: "lookup-value-lookup-value-lookup-value-lookup-value",
      notes: "Pelanggan minta slot awal",
      customerSnapshot: { name: "Ahmad bin Ali", phoneE164: "+60174913169" },
      consent: { termsVersion: "v1", ipHash: "abc", address: "Jalan Besar" },
      headers: { Authorization: "Bearer ya29.super-secret-access-token" },
      detail:
        "Hubungi ahmad@example.com atau 017-491 3169 / 0174913169 / wa.me/60174913169, " +
        "token eyJhbGciOiJ9.eyJzdWIiOiJ9.c2lnbg, " +
        "Bearer ya29.super-secret-access-token, " +
        "kunci -----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----",
    });

    expect(lines).toHaveLength(1);
    const { line } = lines[0]!;
    for (const secret of PLANTED) expect(line).not.toContain(secret);

    expect(JSON.parse(line)).toMatchInlineSnapshot(`
      {
        "bookingId": "bk_8f2k1",
        "consent": {
          "address": "[REDACTED]",
          "ipHash": "[REDACTED]",
          "termsVersion": "v1",
        },
        "customerSnapshot": "[REDACTED]",
        "detail": "Hubungi [EMAIL] atau [PHONE] / [PHONE] / wa.me/[PHONE], token [JWT], Bearer [TOKEN], kunci [PRIVATE_KEY]",
        "email": "[REDACTED]",
        "environment": "production",
        "event": "booking.hold_created",
        "headers": {
          "Authorization": "[REDACTED]",
        },
        "idLast4": "[REDACTED]",
        "level": "info",
        "lockedDates": [
          "2026-12-26",
          "2026-12-27",
        ],
        "lookupToken": "[REDACTED]",
        "name": "[REDACTED]",
        "notes": "[REDACTED]",
        "phoneE164": "[REDACTED]",
        "phoneHash": "[REDACTED]",
        "pickupAt": "2026-12-26T01:00:00.000Z",
        "refCode": "PK-7F3K9Q",
        "status": "pending_payment",
        "time": "2026-12-24T12:00:00.000Z",
        "totalPayableSen": 16900,
        "unitId": "unit01",
      }
    `);
  });

  it("scrubs error messages and their causes, and hides stacks once deployed", () => {
    const { logger, lines } = capture("production");
    const cause = new Error("lookup failed for ahmad@example.com");
    const error = Object.assign(new Error("could not notify +60174913169", { cause }), {
      code: "UNAVAILABLE",
      httpStatus: 503,
    });

    logger.error("request.failed", { error });

    const parsed = JSON.parse(lines[0]!.line) as { error: Record<string, unknown> };
    expect(lines[0]!.level).toBe("error");
    expect(parsed.error).toEqual({
      name: "Error",
      message: "could not notify [PHONE]",
      code: "UNAVAILABLE",
      httpStatus: 503,
      cause: { name: "Error", message: "lookup failed for [EMAIL]" },
    });
  });

  it("includes stacks in development, still scrubbed", () => {
    const { logger, lines } = capture("development");
    logger.warn("job.retry", { error: new Error("retry for ahmad@example.com") });

    const parsed = JSON.parse(lines[0]!.line) as { error: { stack: string } };
    expect(parsed.error.stack).toContain("Error: retry for [EMAIL]");
    expect(lines[0]!.line).not.toContain("ahmad@example.com");
  });

  it("does not let fields overwrite the log envelope", () => {
    const { logger, lines } = capture();
    logger.debug("real.event", {
      event: "fake",
      level: "error",
      environment: "fake",
      time: "fake",
    });
    expect(JSON.parse(lines[0]!.line)).toEqual({
      event: "real.event",
      level: "debug",
      environment: "production",
      time: "2026-12-24T12:00:00.000Z",
    });
  });
});

describe("redact", () => {
  it("handles awkward values without throwing", () => {
    const circular: Record<string, unknown> = { id: "a" };
    circular.self = circular;

    expect(
      redact({
        circular,
        deep: { a: { b: { c: { d: { e: { f: { g: "too deep" } } } } } } },
        list: Array.from({ length: 60 }, (_, index) => index),
        missing: undefined,
        nothing: null,
        big: 10n,
        fn: () => 1,
        nan: NaN,
        badDate: new Date(NaN),
        long: "kata ".repeat(420),
      }),
    ).toEqual({
      circular: { id: "a", self: "[CIRCULAR]" },
      deep: { a: { b: { c: { d: { e: "[TRUNCATED]" } } } } },
      list: Array.from({ length: 50 }, (_, index) => index),
      missing: null,
      nothing: null,
      big: "10",
      fn: "[function]",
      nan: "NaN",
      badDate: "[INVALID_DATE]",
      long: `${"kata ".repeat(400)}…`,
    });
  });
});

describe("scrubText", () => {
  it.each([
    "2026-12-24",
    "2026-12-24T12:00:00.000Z",
    "PK-7F3K9Q",
    "bookings/Xk2pQ9LmN4vR7sT1uW3y",
    "unit01_2026-12-24",
    "amount 16900 sen for 3 days",
    "HTTP 409 ALREADY_EXISTS",
  ])("leaves operational text %s untouched", (text) => {
    expect(scrubText(text)).toBe(text);
  });
});

describe("default sink", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes to the console method that matches the level", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logger = createLogger({ environment: "test" });

    logger.debug("a");
    logger.info("b");
    logger.warn("c");
    logger.error("d");

    expect(log).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledOnce();
    expect(JSON.parse(log.mock.calls[1]![0] as string)).toMatchObject({
      event: "b",
      level: "info",
    });
  });
});
