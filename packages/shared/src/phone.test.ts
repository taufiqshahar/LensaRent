import { describe, expect, it } from "vitest";
import { e164Digits, formatMyMobile, normalizeMyMobile, whatsappUrl } from "./phone";

describe("normalizeMyMobile", () => {
  it.each([
    ["017-491 3169", "+60174913169"],
    ["0174913169", "+60174913169"],
    ["+60 17 491 3169", "+60174913169"],
    ["60174913169", "+60174913169"],
    ["(017) 491.3169", "+60174913169"],
    ["011-1234 5678", "+601112345678"],
    ["  +601112345678 ", "+601112345678"],
  ])("normalises %s", (input, expected) => {
    expect(normalizeMyMobile(input)).toBe(expected);
  });

  it.each([
    ["a landline", "04-5931234"],
    ["a landline in E.164", "+6045931234"],
    ["a Singapore number", "+6591234567"],
    ["too short", "017-491 316"],
    ["too long", "011-1234 56789"],
    ["letters", "017-ABC 3169"],
    ["a plus sign in the middle", "60+174913169"],
    ["no country or trunk prefix", "174913169"],
    ["empty", ""],
  ])("rejects %s", (_label, input) => {
    expect(normalizeMyMobile(input)).toBeNull();
  });
});

describe("formatting and links", () => {
  it("formats for display", () => {
    expect(formatMyMobile("+60174913169")).toBe("017-491 3169");
    expect(formatMyMobile("+601112345678")).toBe("011-1234 5678");
    expect(formatMyMobile("+6591234567")).toBe("+6591234567");
  });

  it("builds a wa.me link with an encoded message", () => {
    expect(e164Digits("+60174913169")).toBe("60174913169");
    expect(whatsappUrl("+60174913169", "Hai, saya nak sewa & tanya harga?")).toBe(
      "https://wa.me/60174913169?text=Hai%2C%20saya%20nak%20sewa%20%26%20tanya%20harga%3F",
    );
  });
});
