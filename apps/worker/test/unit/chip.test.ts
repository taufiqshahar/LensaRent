import { beforeEach, describe, expect, it } from "vitest";
import type { CheckoutInput } from "../../src/lib/chip";
import {
  PaymentProviderError,
  PaymentSignatureError,
  createChipProvider,
} from "../../src/lib/chip";
import type { FakeChip } from "../support/fakeChip";
import { createFakeChip } from "../support/fakeChip";

const checkout: CheckoutInput = {
  reference: "PK-ABCDEF",
  customer: { email: "a@example.com", fullName: "Nur Aisyah", phone: "+60123456789" },
  lines: [
    { name: "Sewa", priceSen: 6900 },
    { name: "Deposit", priceSen: 10000 },
  ],
  due: new Date("2026-12-01T00:15:00.000Z"),
  successRedirect: "https://x.test/ok",
  failureRedirect: "https://x.test/fail",
  cancelRedirect: "https://x.test/cancel",
  callbackUrl: "https://x.test/api/webhooks/chip",
};

let chip: FakeChip;
beforeEach(async () => {
  chip = await createFakeChip();
});

function provider(options: { pinned?: boolean; fetch?: typeof fetch } = {}) {
  return createChipProvider({
    secretKey: "k",
    brandId: "b",
    publicKeyPem: options.pinned === false ? undefined : chip.publicKeyPem,
    fetch: options.fetch ?? chip.fetch,
  });
}

describe("createCheckout", () => {
  it("creates a strict-due purchase in sen with the products as given", async () => {
    const result = await provider().createCheckout(checkout);
    const purchase = chip.byReference("PK-ABCDEF");
    expect(result).toEqual({
      providerRef: purchase.id,
      checkoutUrl: purchase.checkout_url,
      isTest: true,
    });
    expect(chip.requests[0]?.body).toEqual({
      brand_id: "b",
      reference: "PK-ABCDEF",
      client: { email: "a@example.com", full_name: "Nur Aisyah", phone: "+60123456789" },
      purchase: {
        currency: "MYR",
        language: "ms",
        timezone: "Asia/Kuala_Lumpur",
        due_strict: true,
        products: [
          { name: "Sewa", price: 6900 },
          { name: "Deposit", price: 10000 },
        ],
      },
      due: Math.floor(checkout.due.getTime() / 1000),
      send_receipt: false,
      success_redirect: "https://x.test/ok",
      failure_redirect: "https://x.test/fail",
      cancel_redirect: "https://x.test/cancel",
      success_callback: "https://x.test/api/webhooks/chip",
    });
  });

  it("raises a provider error for a refusal, a network failure or a strange answer", async () => {
    chip.failNextCreate = 400;
    await expect(provider().createCheckout(checkout)).rejects.toThrow(PaymentProviderError);

    const offline = provider({ fetch: () => Promise.reject(new Error("offline")) });
    await expect(offline.createCheckout(checkout)).rejects.toThrow(PaymentProviderError);

    const strange = provider({
      fetch: () => Promise.resolve(new Response("<html>", { status: 201 })),
    });
    await expect(strange.createCheckout(checkout)).rejects.toThrow(/not understood/);

    const noUrl = provider({
      fetch: () =>
        Promise.resolve(
          Response.json({ id: "p1", status: "created", purchase: { total: 1, currency: "MYR" } }),
        ),
    });
    await expect(noUrl.createCheckout(checkout)).rejects.toThrow(/no checkout URL/);
  });
});

describe("verifyAndParseWebhook", () => {
  async function created() {
    const { providerRef } = await provider().createCheckout(checkout);
    return providerRef;
  }

  it("accepts a correctly signed callback", async () => {
    const id = await created();
    const event = await provider().verifyAndParseWebhook(await chip.callback(id));
    expect(event).toEqual({ eventType: "purchase.paid", providerRef: id });
  });

  it("fetches the public key once when none is pinned (a JSON string, per the docs)", async () => {
    const id = await created();
    const unpinned = provider({ pinned: false });
    await unpinned.verifyAndParseWebhook(await chip.callback(id));
    await unpinned.verifyAndParseWebhook(await chip.callback(id));
    expect(chip.requests.filter((r) => r.path === "/public_key/")).toHaveLength(1);
  });

  it("rejects a missing, forged or garbage signature", async () => {
    const id = await created();
    const callback = await chip.callback(id);
    const body = await callback.clone().text();
    const missing = new Request(callback.url, { method: "POST", body });
    await expect(provider().verifyAndParseWebhook(missing)).rejects.toThrow(PaymentSignatureError);
    for (const signature of [btoa("forged"), "%%%not-base64%%%"]) {
      await expect(
        provider().verifyAndParseWebhook(await chip.callback(id, "purchase.paid", signature)),
      ).rejects.toThrow(PaymentSignatureError);
    }
  });

  it("rejects a body that was changed after signing", async () => {
    const id = await created();
    const callback = await chip.callback(id);
    const tampered = new Request(callback.url, {
      method: "POST",
      headers: callback.headers,
      body: (await callback.text()).replace('"total":16900', '"total":1'),
    });
    await expect(provider().verifyAndParseWebhook(tampered)).rejects.toThrow(PaymentSignatureError);
  });

  it("rejects signed bodies that are not purchases", async () => {
    for (const body of ["not json", JSON.stringify({ hello: "world" })]) {
      const request = new Request("https://x.test/api/webhooks/chip", {
        method: "POST",
        headers: { "x-signature": await chip.sign(body) },
        body,
      });
      await expect(provider().verifyAndParseWebhook(request)).rejects.toThrow(
        PaymentSignatureError,
      );
    }
  });

  it("reports an unreachable key service as a provider error, not a bad signature", async () => {
    const id = await created();
    const request = await chip.callback(id);
    const broken = provider({
      pinned: false,
      fetch: () => Promise.resolve(new Response("", { status: 503 })),
    });
    await expect(broken.verifyAndParseWebhook(request)).rejects.toThrow(PaymentProviderError);
    const garbled = provider({
      pinned: false,
      fetch: () => Promise.resolve(Response.json({ key: 1 })),
    });
    await expect(garbled.verifyAndParseWebhook(await chip.callback(id))).rejects.toThrow(
      /not understood/,
    );
  });
});

describe("fetchPayment and cancel", () => {
  it("reads a purchase before and after payment", async () => {
    const { providerRef } = await provider().createCheckout(checkout);
    expect(await provider().fetchPayment(providerRef)).toMatchObject({
      status: "created",
      paid: false,
      totalSen: 16900,
      paidSen: null,
      feeSen: null,
      paidAt: null,
      reference: "PK-ABCDEF",
    });
    chip.pay(providerRef, { fee: 250 });
    const paid = await provider().fetchPayment(providerRef);
    expect(paid).toMatchObject({
      paid: true,
      paidSen: 16900,
      feeSen: 250,
      currency: "MYR",
      isTest: true,
    });
    expect(paid.paidAt).toBeInstanceOf(Date);
  });

  it("cancels an unpaid purchase and reports when it cannot", async () => {
    const { providerRef } = await provider().createCheckout(checkout);
    expect(await provider().cancel(providerRef)).toBe(true);
    const second = await provider().createCheckout(checkout);
    chip.pay(second.providerRef);
    expect(await provider().cancel(second.providerRef)).toBe(false);
    chip.cancelStatus = 502;
    await expect(provider().cancel(providerRef)).rejects.toThrow(PaymentProviderError);
  });

  it("never puts an unexpected id into a URL", async () => {
    await expect(provider().fetchPayment("../../brands")).rejects.toThrow(/Invalid purchase id/);
    await expect(provider().cancel("a/b")).rejects.toThrow(/Invalid purchase id/);
    expect(chip.requests).toEqual([]);
  });
});
