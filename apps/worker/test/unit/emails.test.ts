import { describe, expect, it } from "vitest";
import { createHasher } from "../../src/lib/crypto";
import { escapeHtml, renderEmail } from "../../src/lib/emails";
import { testDb } from "../helpers";
import { TEST_SETTINGS } from "../support/booking";

const context = {
  db: testDb(),
  hasher: createHasher("test-pepper-test-pepper-test-pepper"),
  settings: TEST_SETTINGS,
  siteOrigin: undefined,
};

describe("emails", () => {
  it("escape every HTML special character", () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
    );
  });

  it("render nothing for a message whose booking or date is missing", async () => {
    expect(await renderEmail(context, "booking_confirmed", { bookingId: "nope" })).toBeNull();
    expect(await renderEmail(context, "booking_confirmed", {})).toBeNull();
    expect(await renderEmail(context, "admin_daily_summary", {})).toBeNull();
  });

  it("render an empty day's summary without a link when no site origin is set", async () => {
    const email = await renderEmail(context, "admin_daily_summary", { date: "2029-06-01" });
    expect(email?.subject).toMatch(/0 ambil, 0 pulang/);
    expect(email?.text).toContain("Tiada.");
    expect(email?.html).not.toContain("<a ");
  });
});
