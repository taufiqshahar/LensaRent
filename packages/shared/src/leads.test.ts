import { describe, expect, it } from "vitest";
import {
  LEAD_SOURCES,
  LEAD_SOURCE_LABELS,
  LEAD_STATUSES,
  LEAD_STATUS_LABELS,
  LEAD_USAGES,
  LEAD_USAGE_LABELS,
  leadSubmissionSchema,
  leadUpdateSchema,
} from "./leads";

const valid = {
  name: "  Aisyah  ",
  phone: "017-491 3169",
  desiredDate: "2026-12-24",
  usage: "travel",
  source: "tiktok",
  consent: true,
  turnstileToken: "token",
};

describe("leadSubmissionSchema", () => {
  it("normalises a valid submission", () => {
    expect(leadSubmissionSchema.parse(valid)).toEqual({
      name: "Aisyah",
      phone: "+60174913169",
      desiredDate: "2026-12-24",
      usage: "travel",
      source: "tiktok",
      consent: true,
      turnstileToken: "token",
    });
  });

  it("treats a missing or empty date as not decided", () => {
    expect(leadSubmissionSchema.parse({ ...valid, desiredDate: "" }).desiredDate).toBeNull();
    const { desiredDate: _omitted, ...withoutDate } = valid;
    expect(leadSubmissionSchema.parse(withoutDate).desiredDate).toBeNull();
  });

  it.each([
    ["a one-letter name", { name: "A" }, "name"],
    ["a name that is too long", { name: "x".repeat(81) }, "name"],
    ["a name with control characters", { name: "Ali\u0000" }, "name"],
    ["a landline", { phone: "04-5931234" }, "phone"],
    ["an impossible date", { desiredDate: "2026-02-30" }, "desiredDate"],
    ["an unknown usage", { usage: "drone" }, "usage"],
    ["an unknown source", { source: "radio" }, "source"],
    ["no consent", { consent: false }, "consent"],
    ["a missing Turnstile token", { turnstileToken: "" }, "turnstileToken"],
    ["an unknown field", { priceSen: 1 }, ""],
  ])("rejects %s", (_label, override, field) => {
    const result = leadSubmissionSchema.safeParse({ ...valid, ...override });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toContain(field);
  });
});

describe("leadUpdateSchema", () => {
  it("accepts a status, notes, or both", () => {
    expect(leadUpdateSchema.parse({ status: "contacted" })).toEqual({ status: "contacted" });
    expect(leadUpdateSchema.parse({ notes: "  Tanya\nsemula Jumaat  " })).toEqual({
      notes: "Tanya\nsemula Jumaat",
    });
  });

  it.each([
    ["nothing", {}],
    ["an unknown status", { status: "won" }],
    ["notes with control characters", { notes: "a\u0007b" }],
    ["notes that are too long", { notes: "x".repeat(2001) }],
    ["an unknown field", { name: "Ali" }],
  ])("rejects %s", (_label, value) => {
    expect(leadUpdateSchema.safeParse(value).success).toBe(false);
  });
});

describe("labels", () => {
  it("cover every value", () => {
    expect(Object.keys(LEAD_USAGE_LABELS).sort()).toEqual([...LEAD_USAGES].sort());
    expect(Object.keys(LEAD_SOURCE_LABELS).sort()).toEqual([...LEAD_SOURCES].sort());
    expect(Object.keys(LEAD_STATUS_LABELS).sort()).toEqual([...LEAD_STATUSES].sort());
  });
});
