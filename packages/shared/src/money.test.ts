import { describe, expect, it } from "vitest";
import { DomainError } from "./errors";
import { assertSen, formatRM, isSen, multiplySen, sumSen } from "./money";

describe("isSen / assertSen", () => {
  it.each([0, 6900, -3000, Number.MAX_SAFE_INTEGER])("accepts integer sen %d", (value) => {
    expect(isSen(value)).toBe(true);
    expect(() => {
      assertSen(value);
    }).not.toThrow();
  });

  it.each([69.5, 0.1 + 0.2, NaN, Infinity, 2 ** 53, "100", null, undefined, 100n])(
    "rejects non-integer money %s",
    (value) => {
      expect(isSen(value)).toBe(false);
      expect(() => {
        assertSen(value);
      }).toThrow(DomainError);
    },
  );

  it("reports INVALID_AMOUNT with the given label", () => {
    expect(() => {
      assertSen(1.5, "deposit");
    }).toThrow(
      expect.objectContaining({
        code: "INVALID_AMOUNT",
        message: expect.stringContaining("deposit") as string,
      }),
    );
  });
});

describe("sumSen", () => {
  it("adds integer sen exactly", () => {
    expect(sumSen([])).toBe(0);
    expect(sumSen([6900, 500, 10000])).toBe(17400);
    expect(sumSen([10000, -1500, -8500])).toBe(0);
  });

  it("never lets a float into a total", () => {
    expect(() => sumSen([6900, 0.5])).toThrow(DomainError);
  });

  it("rejects a total that is no longer a safe integer", () => {
    expect(() => sumSen([Number.MAX_SAFE_INTEGER, 1])).toThrow(DomainError);
  });
});

describe("multiplySen", () => {
  it("multiplies a unit price by a whole quantity", () => {
    expect(multiplySen(5000, 4)).toBe(20000);
    expect(multiplySen(500, 0)).toBe(0);
  });

  it.each([
    [500, -1],
    [500, 1.5],
    [500.5, 2],
    [Number.MAX_SAFE_INTEGER, 2],
  ])("rejects unit %d × quantity %d", (unit, quantity) => {
    expect(() => multiplySen(unit, quantity)).toThrow(DomainError);
  });
});

describe("formatRM", () => {
  it.each([
    [6900, "RM69.00"],
    [5, "RM0.05"],
    [0, "RM0.00"],
    [-3000, "-RM30.00"],
    [123456, "RM1,234.56"],
    [100000000, "RM1,000,000.00"],
    [10000, "RM100.00"],
  ])("formats %d sen as %s", (sen, expected) => {
    expect(formatRM(sen)).toBe(expected);
  });

  it("rejects floats", () => {
    expect(() => formatRM(69.9)).toThrow(DomainError);
  });
});
