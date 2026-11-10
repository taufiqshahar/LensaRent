import { describe, expect, it } from "vitest";
import {
  FirestoreValueError,
  decodeFields,
  decodeValue,
  encodeDocument,
  encodeValue,
  fieldPathSegment,
  increment,
  serverTimestamp,
} from "../../src/lib/firestoreValues";

describe("encodeValue", () => {
  it.each([
    [null, { nullValue: null }],
    [true, { booleanValue: true }],
    ["PK-7F3K9Q", { stringValue: "PK-7F3K9Q" }],
    [6900, { integerValue: "6900" }],
    [-3000, { integerValue: "-3000" }],
    [-0, { integerValue: "0" }],
    [new Date("2026-12-24T12:00:00.000Z"), { timestampValue: "2026-12-24T12:00:00.000Z" }],
    [[1, "a"], { arrayValue: { values: [{ integerValue: "1" }, { stringValue: "a" }] } }],
    [
      { a: { b: 1 } },
      { mapValue: { fields: { a: { mapValue: { fields: { b: { integerValue: "1" } } } } } } },
    ],
  ])("encodes %j", (input, expected) => {
    expect(encodeValue(input)).toEqual(expected);
  });

  it.each([69.5, 0.1 + 0.2, NaN, Infinity, 2 ** 53])(
    "rejects the non-integer number %d",
    (value) => {
      expect(() => encodeValue(value)).toThrow(FirestoreValueError);
    },
  );

  it.each([
    ["undefined", undefined],
    ["a bigint", 10n],
    ["a function", () => 1],
    ["a symbol", Symbol("x")],
    ["a Map", new Map()],
    ["a class instance", new URL("https://example.test")],
    ["an invalid Date", new Date(NaN)],
    ["undefined inside an array", [undefined]],
  ])("rejects %s", (_label, value) => {
    expect(() => encodeValue(value)).toThrow(FirestoreValueError);
  });

  it("rejects transforms inside arrays, where they cannot be addressed", () => {
    expect(() => encodeValue([serverTimestamp()])).toThrow(FirestoreValueError);
    expect(() => encodeValue([{ at: serverTimestamp() }])).toThrow(FirestoreValueError);
    expect(() => encodeValue([increment(1)])).toThrow(FirestoreValueError);
  });
});

describe("encodeDocument", () => {
  it("separates stored fields from server-side transforms", () => {
    const encoded = encodeDocument({
      status: "confirmed",
      amountSen: 16900,
      skipped: undefined,
      updatedAt: serverTimestamp(),
      counters: { attempts: increment(1), label: "x" },
    });

    expect(encoded.fields).toEqual({
      status: { stringValue: "confirmed" },
      amountSen: { integerValue: "16900" },
      counters: { mapValue: { fields: { label: { stringValue: "x" } } } },
    });
    expect(encoded.transforms).toEqual([
      { fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" },
      { fieldPath: "counters.attempts", increment: { integerValue: "1" } },
    ]);
    expect(encoded.maskPaths).toEqual(["status", "amountSen", "counters"]);
  });

  it("quotes field names that are not simple identifiers", () => {
    expect(encodeDocument({ "2026-12-24": true, plain_name: true }).maskPaths).toEqual([
      "`2026-12-24`",
      "plain_name",
    ]);
    expect(fieldPathSegment("a`b\\c")).toBe("`a\\`b\\\\c`");
  });

  it("rejects reserved and empty field names", () => {
    expect(() => encodeDocument({ __name__: 1 })).toThrow(FirestoreValueError);
    expect(() => encodeDocument({ "": 1 })).toThrow(FirestoreValueError);
  });

  it("rejects data that is not a plain object", () => {
    expect(() => encodeDocument([] as unknown as Record<string, unknown>)).toThrow(
      FirestoreValueError,
    );
    expect(() => increment(1.5)).toThrow(FirestoreValueError);
  });
});

describe("decoding", () => {
  it("round-trips a document", () => {
    const data = {
      refCode: "PK-7F3K9Q",
      totalPayableSen: 16900,
      pickupAt: new Date("2026-12-24T12:00:00.000Z"),
      flags: ["late", "vip"],
      holdExpiresAt: null,
      confirmed: false,
      priceBreakdown: { rentalSen: 6900, lines: [{ code: "CPL", qty: 1 }] },
    };
    expect(decodeFields(encodeDocument(data).fields)).toEqual(data);
  });

  it("reads values written by other tools", () => {
    expect(decodeValue({ doubleValue: 1.5 })).toBe(1.5);
    expect(decodeValue({ referenceValue: "projects/p/databases/(default)/documents/a/b" })).toBe(
      "projects/p/databases/(default)/documents/a/b",
    );
    expect(decodeValue({ arrayValue: {} })).toEqual([]);
    expect(decodeValue({ mapValue: {} })).toEqual({});
    expect(decodeFields(undefined)).toEqual({});
  });

  it("rejects integers it cannot represent exactly, and unknown types", () => {
    expect(() => decodeValue({ integerValue: "9007199254740993" })).toThrow(FirestoreValueError);
    expect(() => decodeValue({ bytesValue: "AAAA" } as never)).toThrow(FirestoreValueError);
  });
});
