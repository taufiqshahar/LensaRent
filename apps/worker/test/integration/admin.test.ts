import { mytDateTime } from "@lensarent/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { RATE_LIMIT_RULES } from "../../src/lib/rateLimit";
import { SESSION_COOKIE } from "../../src/lib/sessions";
import { createDoc } from "../../src/lib/firestore";
import { emulatorDb } from "../helpers";
import { createUser } from "./authEmulator";
import { ORIGIN, call, jsonInit, randomIp, testApp } from "./app";

const db = emulatorDb();
const app = testApp();

let admin: { uid: string; email: string; password: string };
let staff: { uid: string; email: string; password: string };

beforeAll(async () => {
  [admin, staff] = await Promise.all([createUser({ admin: true }), createUser({ admin: false })]);
});

async function login(email: string, password: string, ip = randomIp()) {
  return call(
    app,
    "/api/admin/session",
    jsonInit("POST", { email, password }, { "cf-connecting-ip": ip }),
  );
}

function cookieFrom(response: Response): string {
  const header = response.headers.get("set-cookie") ?? "";
  const value = header.split(";")[0] ?? "";
  if (!value.startsWith(`${SESSION_COOKIE}=`)) throw new Error("no session cookie");
  return value;
}

async function signedInAs(): Promise<{ cookie: string; uid: string }> {
  const user = await createUser({ admin: true });
  const response = await login(user.email, user.password);
  expect(response.status).toBe(200);
  return { cookie: cookieFrom(response), uid: user.uid };
}

describe("admin sign-in", () => {
  it("signs an admin in with an HttpOnly session cookie", async () => {
    const response = await login(admin.email.toUpperCase(), admin.password);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ email: admin.email });
    const header = response.headers.get("set-cookie")!;
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Strict");

    const me = await call(app, "/api/admin/session", { headers: { cookie: cookieFrom(response) } });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ email: admin.email });
  });

  it("stores only a hash of the session token, and audits the sign-in", async () => {
    const response = await login(admin.email, admin.password);
    const token = cookieFrom(response).split("=")[1]!;
    const sessions = await db.query({
      collection: "adminSessions",
      where: [["uid", "==", admin.uid]],
      limit: 50,
    });
    expect(sessions.length).toBeGreaterThan(0);
    for (const session of sessions) {
      expect(session.id).not.toBe(token);
      expect(JSON.stringify(session.data)).not.toContain(token);
    }
    const audits = await db.query({
      collection: "auditLogs",
      where: [
        ["actorId", "==", admin.uid],
        ["action", "==", "admin.login"],
      ],
      limit: 50,
    });
    expect(audits.length).toBeGreaterThan(0);
  });

  it.each([
    ["a wrong password", () => login(admin.email, "wrong-password")],
    ["an unknown account", () => login("nobody@example.com", "whatever")],
    ["an account without the admin claim", () => login(staff.email, staff.password)],
    ["a malformed body", () => call(app, "/api/admin/session", jsonInit("POST", { email: 1 }))],
  ])("gives the same answer for %s", async (_label, attempt) => {
    const response = await attempt();
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.json()).toEqual({
      error: { code: "LOGIN_FAILED", message: "Emel atau kata laluan salah." },
    });
  });

  it("refuses a sign-in posted from another site", async () => {
    const response = await call(
      app,
      "/api/admin/session",
      jsonInit(
        "POST",
        { email: admin.email, password: admin.password },
        { origin: "https://evil.test" },
      ),
    );
    expect(response.status).toBe(403);
  });

  it(`allows ${RATE_LIMIT_RULES.loginPerEmail.limit.toString()} attempts per email in 15 minutes`, async () => {
    const target = await createUser({ admin: true });
    const statuses: number[] = [];
    for (let attempt = 0; attempt <= RATE_LIMIT_RULES.loginPerEmail.limit; attempt++) {
      statuses.push((await login(target.email, "wrong-password")).status);
    }
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
    // Even the right password is refused until the window ends.
    expect((await login(target.email, target.password)).status).toBe(429);
  });

  it("signs out, after which the cookie is worthless", async () => {
    const { cookie } = await signedInAs();
    const crossSite = await call(app, "/api/admin/session", {
      method: "DELETE",
      headers: { cookie, origin: "https://evil.test" },
    });
    expect(crossSite.status).toBe(403);

    const out = await call(app, "/api/admin/session", {
      method: "DELETE",
      headers: { cookie, origin: ORIGIN },
    });
    expect(out.status).toBe(204);
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");

    const after = await call(app, "/api/admin/session", { headers: { cookie } });
    expect(after.status).toBe(401);
  });

  it("refuses requests without a session or with a forged one", async () => {
    expect((await call(app, "/api/admin/leads")).status).toBe(401);
    const forged = await call(app, "/api/admin/leads", {
      headers: { cookie: `${SESSION_COOKIE}=${"A".repeat(43)}` },
    });
    expect(forged.status).toBe(401);
    expect(
      (await call(app, "/api/admin/leads", { headers: { cookie: `${SESSION_COOKIE}=short` } }))
        .status,
    ).toBe(401);
  });

  it("ends a session that has expired", async () => {
    const { cookie } = await signedInAs();
    const later = testApp({ now: () => new Date(Date.now() + 9 * 60 * 60 * 1000) });
    expect((await call(later, "/api/admin/session", { headers: { cookie } })).status).toBe(401);
    // Deleted, so it stays dead even at the right time.
    expect((await call(app, "/api/admin/session", { headers: { cookie } })).status).toBe(401);
  });

  it("ends a session after an hour without activity", async () => {
    const { cookie } = await signedInAs();
    const idle = testApp({ now: () => new Date(Date.now() + 61 * 60 * 1000) });
    expect((await call(idle, "/api/admin/session", { headers: { cookie } })).status).toBe(401);
  });

  it("extends the idle deadline while the admin is active", async () => {
    const { cookie } = await signedInAs();
    const start = Date.now();
    for (const minutes of [50, 100, 150]) {
      const active = testApp({ now: () => new Date(start + minutes * 60 * 1000) });
      expect((await call(active, "/api/admin/session", { headers: { cookie } })).status).toBe(200);
    }
  });
});

/** Leads seeded on one random far-future day, so filters see only this test's data. */
async function seedLeads(): Promise<{ day: string; ids: string[] }> {
  const year = 2050 + Math.floor(Math.random() * 40);
  const day = `${year.toString()}-0${(Math.floor(Math.random() * 9) + 1).toString()}-1${Math.floor(Math.random() * 9).toString()}`;
  const statuses = ["new", "new", "contacted", "converted", "new"] as const;
  const ids = statuses.map(
    (_, index) =>
      `seed${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}${index.toString().padStart(4, "0")}`,
  );
  await db.commit(
    statuses.map((status, index) =>
      createDoc(`leads/${ids[index]!}`, {
        name: index === 0 ? '=HYPERLINK("http://evil")' : `Pelanggan ${index.toString()}`,
        phoneE164: "+60174913169",
        phoneHash: "hash",
        desiredDate: null,
        usage: "travel",
        source: "tiktok",
        status,
        notes: "",
        consent: { privacyVersion: "draf-0", at: new Date() },
        // 01:00 MYT onwards, one hour apart: the last one is the newest.
        createdAt: new Date(mytDateTime(day, "01:00").getTime() + index * 3_600_000),
        updatedAt: new Date(),
      }),
    ),
  );
  return { day, ids };
}

describe("admin leads", () => {
  it("lists leads for a day, newest first, with filters and pages", async () => {
    const { cookie } = await signedInAs();
    const { day, ids } = await seedLeads();
    const get = (query: string) =>
      call(app, `/api/admin/leads?${query}`, { headers: { cookie } }).then((r) =>
        r.json<{ leads: { id: string; status: string }[]; nextBefore: string | null }>(),
      );

    const all = await get(`from=${day}&to=${day}`);
    expect(all.leads.map((lead) => lead.id).sort()).toEqual([...ids].sort());
    const times = all.leads.map((lead) => (lead as unknown as { createdAt: string }).createdAt);
    expect([...times].sort().reverse()).toEqual(times);
    expect(all.nextBefore).toBeNull();

    const onlyNew = await get(`from=${day}&to=${day}&status=new`);
    expect(onlyNew.leads.every((lead) => lead.status === "new")).toBe(true);
    expect(onlyNew.leads).toHaveLength(3);

    const first = await get(`from=${day}&to=${day}&limit=2`);
    expect(first.leads).toHaveLength(2);
    expect(first.nextBefore).not.toBeNull();
    const second = await get(
      `from=${day}&to=${day}&limit=2&before=${encodeURIComponent(first.nextBefore!)}`,
    );
    expect(second.leads).toHaveLength(2);
    const third = await get(
      `from=${day}&to=${day}&limit=2&before=${encodeURIComponent(second.nextBefore!)}`,
    );
    expect(third.leads).toHaveLength(1);
    const seen = [...first.leads, ...second.leads, ...third.leads].map((lead) => lead.id);
    expect(new Set(seen).size).toBe(5);
  });

  it("refuses bad filters", async () => {
    const { cookie } = await signedInAs();
    for (const query of [
      "status=won",
      "from=2026-02-30",
      "from=2026-12-02&to=2026-12-01",
      "limit=999",
      "before=yesterday",
    ]) {
      const response = await call(app, `/api/admin/leads?${query}`, { headers: { cookie } });
      expect(response.status, query).toBe(400);
    }
  });

  it("changes a lead's status and notes, and audits which fields changed", async () => {
    const { cookie, uid } = await signedInAs();
    const { ids } = await seedLeads();
    const id = ids[1]!;

    const response = await call(
      app,
      `/api/admin/leads/${id}`,
      jsonInit("PUT", { status: "contacted", notes: "WhatsApp 10 pagi" }, { cookie }),
    );
    expect(response.status).toBe(200);
    expect((await db.get(`leads/${id}`)).data).toMatchObject({
      status: "contacted",
      notes: "WhatsApp 10 pagi",
    });

    const audits = await db.query({
      collection: "auditLogs",
      where: [
        ["targetId", "==", id],
        ["action", "==", "lead.update"],
      ],
      limit: 5,
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.data).toMatchObject({
      actorId: uid,
      targetCollection: "leads",
      changedFields: ["status", "notes"],
    });
    expect(JSON.stringify(audits[0]!.data)).not.toContain("WhatsApp 10 pagi");
  });

  it("refuses bad updates", async () => {
    const { cookie } = await signedInAs();
    const { ids } = await seedLeads();
    const id = ids[0]!;
    const put = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      call(app, path, jsonInit("PUT", body, { cookie, ...headers }));

    expect((await put(`/api/admin/leads/${id}`, { status: "won" })).status).toBe(400);
    expect((await put(`/api/admin/leads/${id}`, {})).status).toBe(400);
    expect((await put(`/api/admin/leads/${id}`, { name: "x" })).status).toBe(400);
    expect((await put(`/api/admin/leads/${"Z".repeat(20)}`, { status: "spam" })).status).toBe(404);
    expect((await put("/api/admin/leads/not-an-id", { status: "spam" })).status).toBe(404);
    expect(
      (await put(`/api/admin/leads/${id}`, { status: "spam" }, { origin: "https://evil.test" }))
        .status,
    ).toBe(403);
    expect((await db.get(`leads/${id}`)).data!.status).toBe("new");
  });

  it("exports the filtered leads as CSV, defusing formulas", async () => {
    const { cookie } = await signedInAs();
    const { day } = await seedLeads();
    const response = await call(app, `/api/admin/leads/export?from=${day}&to=${day}`, {
      headers: { cookie },
    });

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

  it("needs a session to export", async () => {
    expect((await call(app, "/api/admin/leads/export")).status).toBe(401);
  });
});
