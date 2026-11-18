import { describe, expect, it } from "vitest";
import type { Env } from "../../src/lib/env";
import { createAccessVerifier } from "../../src/lib/access";
import { TEST_ADMIN, TEST_ENV, testDb } from "../helpers";
import { call, jsonInit, testApp } from "./app";

const db = testDb();
const app = testApp();

/**
 * Production-like admin checks. Keys never resolve here, so no token can verify; this
 * proves the endpoints refuse without reaching the network (the verifier itself is unit
 * tested with real signed tokens in test/unit/access.test.ts).
 */
const accessApp = testApp({
  admins: createAccessVerifier({
    teamDomain: "lensarent.cloudflareaccess.com",
    audience: "d".repeat(64),
    adminEmails: new Set([TEST_ADMIN]),
    keys: () => Promise.reject(new Error("no keys in this test")),
  }),
});

/** Production-like bindings: Access instead of the development admin. */
const ACCESS_ENV: Env = {
  ...TEST_ENV,
  ACCESS_DEV_EMAIL: undefined,
  ACCESS_TEAM_DOMAIN: "lensarent.cloudflareaccess.com",
  ACCESS_AUD: "d".repeat(64),
  ADMIN_EMAILS: TEST_ADMIN,
};

interface LeadRow {
  status: string;
  notes: string;
  updated_at: string;
}

/** Leads on one random far-future day, so filters see only this test's rows. */
async function seedLeads(): Promise<{ day: string; ids: string[] }> {
  const year = 2050 + Math.floor(Math.random() * 40);
  const month = (Math.floor(Math.random() * 9) + 1).toString();
  const date = (Math.floor(Math.random() * 18) + 10).toString();
  const day = `${year.toString()}-0${month}-${date}`;
  const statuses = ["new", "new", "contacted", "converted", "new"];
  const ids = statuses.map(() => crypto.randomUUID().replaceAll("-", "").slice(0, 20));
  // 01:00 MYT onwards, one hour apart: the last one is the newest.
  const base = Date.parse(`${day}T01:00:00+08:00`);
  await db.batch(
    statuses.map((status, index) =>
      db
        .prepare(
          `INSERT INTO leads (id, name, phone_e164, phone_hash, desired_date, usage, source, status,
             notes, privacy_version, consent_at, created_at, updated_at)
           VALUES (?, ?, '+60174913169', 'hash', NULL, 'travel', 'tiktok', ?, '', 'draf-0', ?, ?, ?)`,
        )
        .bind(
          ids[index],
          index === 0 ? '=HYPERLINK("http://evil")' : `Pelanggan ${index.toString()}`,
          status,
          new Date(base + index * 3_600_000).toISOString(),
          new Date(base + index * 3_600_000).toISOString(),
          new Date(base + index * 3_600_000).toISOString(),
        ),
    ),
  );
  return { day, ids };
}

const get = (path: string, env: Env = TEST_ENV, headers: Record<string, string> = {}) =>
  call(env === ACCESS_ENV ? accessApp : app, path, { headers }, env);

describe("admin access", () => {
  it("tells the panel who is signed in", async () => {
    const response = await get("/api/admin/me");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ email: TEST_ADMIN });
  });

  it("refuses every admin endpoint without a valid Cloudflare Access token", async () => {
    for (const path of ["/api/admin/me", "/api/admin/leads", "/api/admin/leads/export"]) {
      const missing = await get(path, ACCESS_ENV);
      expect(missing.status, path).toBe(401);
      expect(await missing.json()).toEqual({
        error: { code: "UNAUTHENTICATED", message: "Sila log masuk." },
      });
      const forged = await get(path, ACCESS_ENV, { "cf-access-jwt-assertion": "forged.token.x" });
      expect(forged.status, path).toBe(401);
    }
    const update = await call(
      accessApp,
      `/api/admin/leads/${"Z".repeat(20)}`,
      jsonInit("PUT", { status: "spam" }),
      ACCESS_ENV,
    );
    expect(update.status).toBe(401);
  });

  it("refuses changes posted from another site", async () => {
    const { ids } = await seedLeads();
    const response = await call(
      app,
      `/api/admin/leads/${ids[0]!}`,
      jsonInit("PUT", { status: "spam" }, { origin: "https://evil.test" }),
    );
    expect(response.status).toBe(403);
  });
});

describe("admin leads", () => {
  it("lists leads for a day, newest first, with filters and stable pages", async () => {
    const { day, ids } = await seedLeads();
    const list = (query: string) =>
      get(`/api/admin/leads?${query}`).then((r) =>
        r.json<{
          leads: { id: string; status: string; createdAt: string }[];
          nextBefore: string | null;
        }>(),
      );

    const all = await list(`from=${day}&to=${day}`);
    expect(all.leads.map((lead) => lead.id)).toEqual([...ids].reverse());
    expect(all.nextBefore).toBeNull();

    const onlyNew = await list(`from=${day}&to=${day}&status=new`);
    expect(onlyNew.leads.map((lead) => lead.status)).toEqual(["new", "new", "new"]);

    const first = await list(`from=${day}&to=${day}&limit=2`);
    const second = await list(
      `from=${day}&to=${day}&limit=2&before=${encodeURIComponent(first.nextBefore!)}`,
    );
    const third = await list(
      `from=${day}&to=${day}&limit=2&before=${encodeURIComponent(second.nextBefore!)}`,
    );
    expect(third.nextBefore).toBeNull();
    const seen = [...first.leads, ...second.leads, ...third.leads].map((lead) => lead.id);
    expect(seen).toEqual([...ids].reverse());
  });

  it("pages correctly through leads that share a timestamp", async () => {
    const at = "2099-01-01T00:00:00.000Z";
    const ids = ["AAAAAAAAAAAAAAAAAAA1", "AAAAAAAAAAAAAAAAAAA2", "AAAAAAAAAAAAAAAAAAA3"].map(
      (id) =>
        `${id.slice(0, 10)}${crypto.randomUUID().replaceAll("-", "").slice(0, 9)}${id.slice(-1)}`,
    );
    await db.batch(
      ids.map((id) =>
        db
          .prepare(
            `INSERT INTO leads (id, name, phone_e164, phone_hash, usage, source, privacy_version,
               consent_at, created_at, updated_at)
             VALUES (?, 'Sama Masa', '+60174913169', 'h', 'vlog', 'other', 'v', ?, ?, ?)`,
          )
          .bind(id, at, at, at),
      ),
    );
    const seen: string[] = [];
    let cursor: string | null = `${at.replace("00.000Z", "00.001Z")}~${"z".repeat(20)}`;
    while (cursor) {
      const page: { leads: { id: string; createdAt: string }[]; nextBefore: string | null } =
        await get(`/api/admin/leads?limit=1&before=${encodeURIComponent(cursor)}`).then((r) =>
          r.json(),
        );
      const lead = page.leads[0];
      if (!lead || lead.createdAt !== at) break;
      seen.push(lead.id);
      cursor = page.nextBefore;
    }
    expect(seen.filter((id) => ids.includes(id)).sort()).toEqual([...ids].sort());
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("refuses bad filters", async () => {
    for (const query of [
      "status=won",
      "from=2026-02-30",
      "from=2026-12-02&to=2026-12-01",
      "limit=999",
      "before=yesterday",
    ]) {
      expect((await get(`/api/admin/leads?${query}`)).status, query).toBe(400);
    }
  });

  it("changes a lead's status and notes, and audits which fields changed", async () => {
    const { ids } = await seedLeads();
    const id = ids[1]!;

    const response = await call(
      app,
      `/api/admin/leads/${id}`,
      jsonInit("PUT", { status: "contacted", notes: "WhatsApp 10 pagi" }),
    );
    expect(response.status).toBe(200);
    const row = await db
      .prepare("SELECT status, notes, updated_at FROM leads WHERE id = ?")
      .bind(id)
      .first<LeadRow>();
    expect(row).toMatchObject({ status: "contacted", notes: "WhatsApp 10 pagi" });

    const { results } = await db
      .prepare("SELECT * FROM audit_logs WHERE target_id = ? AND action = 'lead.update'")
      .bind(id)
      .all<Record<string, string>>();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      actor_id: `dev:${TEST_ADMIN}`,
      actor_email: TEST_ADMIN,
      target_table: "leads",
      changed_fields: '["status","notes"]',
    });
    expect(JSON.stringify(results[0])).not.toContain("WhatsApp 10 pagi");

    // Changing only the notes leaves the status as it was.
    await call(app, `/api/admin/leads/${id}`, jsonInit("PUT", { notes: "Sudah bayar" }));
    expect(
      await db.prepare("SELECT status, notes FROM leads WHERE id = ?").bind(id).first(),
    ).toEqual({ status: "contacted", notes: "Sudah bayar" });
  });

  it("refuses bad updates, and never audits a change that did not happen", async () => {
    const { ids } = await seedLeads();
    const id = ids[0]!;
    const put = (path: string, body: unknown) => call(app, path, jsonInit("PUT", body));
    const missing = "Z".repeat(20);

    expect((await put(`/api/admin/leads/${id}`, { status: "won" })).status).toBe(400);
    expect((await put(`/api/admin/leads/${id}`, {})).status).toBe(400);
    expect((await put(`/api/admin/leads/${id}`, { name: "x" })).status).toBe(400);
    expect((await put(`/api/admin/leads/${missing}`, { status: "spam" })).status).toBe(404);
    expect((await put("/api/admin/leads/not-an-id", { status: "spam" })).status).toBe(404);

    expect(await db.prepare("SELECT status FROM leads WHERE id = ?").bind(id).first()).toEqual({
      status: "new",
    });
    const audits = await db
      .prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE target_id IN (?, ?)")
      .bind(id, missing)
      .first<{ n: number }>();
    expect(audits?.n).toBe(0);
  });

  it("exports the filtered leads as CSV, defusing formulas", async () => {
    const { day } = await seedLeads();
    const response = await get(`/api/admin/leads/export?from=${day}&to=${day}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("content-disposition")).toMatch(
      /^attachment; filename="leads-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    const text = await response.text();
    const lines = text
      .replace(/^\uFEFF/, "")
      .trimEnd()
      .split("\r\n");
    expect(lines[0]).toBe(
      '"Dihantar (MYT)","Nama","Telefon","Tarikh diingini","Kegunaan","Sumber","Status","Nota"',
    );
    expect(lines).toHaveLength(6);
    expect(text).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(text).toContain('"017-491 3169"');
    expect(text).toContain('"Percutian / pelancongan"');
  });
});
