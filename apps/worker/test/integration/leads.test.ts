import { DEFAULT_SETTINGS, addDays, mytDateString } from "@lensarent/shared";
import { describe, expect, it } from "vitest";
import { RATE_LIMIT_RULES } from "../../src/lib/rateLimit";
import { emulatorDb } from "../helpers";
import { call, jsonInit, randomIp, randomPhone, testApp, turnstileChecks } from "./app";

const db = emulatorDb();
const app = testApp();
const today = mytDateString(new Date());

function submission(overrides: Record<string, unknown> = {}) {
  return {
    name: "Nur Aisyah",
    phone: randomPhone(),
    desiredDate: addDays(today, 10),
    usage: "travel",
    source: "tiktok",
    consent: true,
    turnstileToken: "pass",
    ...overrides,
  };
}

function submit(body: unknown, ip = randomIp()) {
  return call(app, "/api/leads", jsonInit("POST", body, { "cf-connecting-ip": ip }));
}

async function leadsByPhoneHash(phoneHash: string) {
  return db.query({ collection: "leads", where: [["phoneHash", "==", phoneHash]], limit: 10 });
}

describe("POST /api/leads", () => {
  it("stores the lead, normalised, without the raw IP", async () => {
    const ip = randomIp();
    const phone =
      "019-" +
      Math.floor(Math.random() * 1e7)
        .toString()
        .padStart(7, "0")
        .replace(/^(\d{3})/, "$1 ");
    const response = await submit(submission({ phone, name: "  Nur Aisyah  " }), ip);

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true });
    expect(turnstileChecks.at(-1)).toEqual({
      token: "pass",
      remoteIp: ip,
      expectedAction: "lead",
      expectedHostname: "lensarent.test",
    });

    const e164 = `+60${phone.replace(/\D/g, "").slice(1)}`;
    const all = await db.query({
      collection: "leads",
      where: [["phoneE164", "==", e164]],
      limit: 5,
    });
    expect(all).toHaveLength(1);
    const stored = all[0]!.data!;
    expect(stored).toMatchObject({
      name: "Nur Aisyah",
      phoneE164: e164,
      desiredDate: addDays(today, 10),
      usage: "travel",
      source: "tiktok",
      status: "new",
      notes: "",
      consent: { privacyVersion: DEFAULT_SETTINGS.policyVersions.privacy },
    });
    expect(stored.phoneHash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(stored.createdAt).toBeInstanceOf(Date);
    expect(JSON.stringify(stored)).not.toContain(ip);
    expect(all[0]!.id).toMatch(/^[A-Za-z0-9]{20}$/);
  });

  it("accepts a lead without a date", async () => {
    expect((await submit(submission({ desiredDate: "" }))).status).toBe(201);
  });

  it("answers invalid input with a message per field, in Bahasa Melayu", async () => {
    const response = await submit(
      submission({ name: "A", phone: "04-5931234", usage: "drone", consent: false }),
    );
    expect(response.status).toBe(400);
    const body = await response.json<{ error: { code: string; fields: Record<string, string> } }>();
    expect(body.error.code).toBe("VALIDATION_FAILED");
    expect(Object.keys(body.error.fields).sort()).toEqual(["consent", "name", "phone", "usage"]);
    expect(body.error.fields.phone).toContain("telefon bimbit Malaysia");
    // Raw input is never echoed back.
    expect(JSON.stringify(body)).not.toContain("04-5931234");
  });

  it.each([
    ["in the past", addDays(today, -1)],
    ["more than a year ahead", addDays(today, 366)],
  ])("refuses a desired date %s", async (_label, desiredDate) => {
    const response = await submit(submission({ desiredDate }));
    expect(response.status).toBe(400);
    expect(
      Object.keys((await response.json<{ error: { fields: object } }>()).error.fields),
    ).toEqual(["desiredDate"]);
  });

  it("refuses a failed Turnstile check before writing anything", async () => {
    const body = submission({ turnstileToken: "bot" });
    const response = await submit(body);
    expect(response.status).toBe(403);
    expect((await response.json<{ error: { code: string } }>()).error.code).toBe(
      "TURNSTILE_FAILED",
    );
    const e164 = `+60${body.phone.slice(1)}`;
    expect(
      await db.query({ collection: "leads", where: [["phoneE164", "==", e164]], limit: 1 }),
    ).toEqual([]);
  });

  it("refuses non-JSON bodies and unknown fields", async () => {
    const form = await call(app, "/api/leads", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "name=x",
    });
    expect(form.status).toBe(415);
    expect((await submit({ ...submission(), totalSen: 1 })).status).toBe(400);
  });

  it(`limits one phone number to ${RATE_LIMIT_RULES.leadPerPhone.limit.toString()} leads a day`, async () => {
    const phone = randomPhone();
    const statuses: number[] = [];
    for (let attempt = 0; attempt <= RATE_LIMIT_RULES.leadPerPhone.limit; attempt++) {
      statuses.push((await submit(submission({ phone }))).status);
    }
    expect(statuses).toEqual([201, 201, 201, 429]);

    const last = await submit(submission({ phone }));
    expect(Number(last.headers.get("Retry-After"))).toBeGreaterThan(0);

    const stored = await db.query({
      collection: "leads",
      where: [["phoneE164", "==", `+60${phone.slice(1)}`]],
      limit: 10,
    });
    expect(stored).toHaveLength(3);
    expect(await leadsByPhoneHash(stored[0]!.data!.phoneHash as string)).toHaveLength(3);
  });

  it(`limits one IP to ${RATE_LIMIT_RULES.leadPerIp.limit.toString()} leads an hour`, async () => {
    const ip = randomIp();
    const statuses: number[] = [];
    for (let attempt = 0; attempt <= RATE_LIMIT_RULES.leadPerIp.limit; attempt++) {
      statuses.push((await submit(submission(), ip)).status);
    }
    expect(statuses.filter((status) => status === 201)).toHaveLength(
      RATE_LIMIT_RULES.leadPerIp.limit,
    );
    expect(statuses.at(-1)).toBe(429);
  });

  it("counts simultaneous submissions exactly", async () => {
    const phone = randomPhone();
    const statuses = await Promise.all(
      Array.from({ length: 6 }, () => submit(submission({ phone })).then((r) => r.status)),
    );
    expect(statuses.filter((status) => status === 201)).toHaveLength(3);
    expect(statuses.filter((status) => status === 429)).toHaveLength(3);
  });

  it("stops a burst early when the burst limiter says so", async () => {
    const limited = testApp({ burstLimiter: { limit: () => Promise.resolve({ success: false }) } });
    const response = await call(limited, "/api/leads", jsonInit("POST", submission()));
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
  });
});
