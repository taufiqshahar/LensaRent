import { fakePem } from "../helpers";

/**
 * A stand-in for the CHIP Collect API, answering through an injected `fetch`. It signs
 * callbacks with its own freshly generated RSA key, exactly as CHIP does (base64 RSA
 * PKCS#1 v1.5 over the SHA-256 of the raw body), so the real adapter verifies them.
 */
export interface FakePurchase {
  id: string;
  status: string;
  reference: string;
  checkout_url: string;
  is_test: boolean;
  due: number;
  purchase: { total: number; currency: string; products: { name: string; price: number }[] };
  payment: { amount: number; fee_amount: number; paid_on: number } | null;
}

export interface FakeChip {
  fetch: typeof fetch;
  publicKeyPem: string;
  purchases: Map<string, FakePurchase>;
  requests: { method: string; path: string; body: unknown; authorization: string | null }[];
  /** Status the next POST /purchases/ answers with instead of 201. */
  failNextCreate: number | null;
  /** Status POST /cancel/ answers with; null = cancel normally. */
  cancelStatus: number | null;
  /** Purchases are created in test mode unless this is false. */
  testMode: boolean;
  byReference(reference: string): FakePurchase;
  pay(id: string, overrides?: { amount?: number; fee?: number; currency?: string }): void;
  sign(body: string): Promise<string>;
  callback(id: string, eventType?: string, signature?: string): Promise<Request>;
}

function toBase64(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function createFakeChip(): Promise<FakeChip> {
  const keys = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const spki = (await crypto.subtle.exportKey("spki", keys.publicKey)) as ArrayBuffer;
  const publicKeyPem = fakePem("PUBLIC KEY", toBase64(spki).replace(/(.{64})/g, "$1\n"));

  const chip: FakeChip = {
    publicKeyPem,
    purchases: new Map(),
    requests: [],
    failNextCreate: null,
    cancelStatus: null,
    testMode: true,

    fetch: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const path = url.pathname.replace(/^\/api\/v1/, "");
      const body: unknown =
        request.method === "POST" ? await request.json().catch(() => null) : null;
      chip.requests.push({
        method: request.method,
        path,
        body,
        authorization: request.headers.get("authorization"),
      });

      if (request.method === "GET" && path === "/public_key/") return json(publicKeyPem);

      if (request.method === "POST" && path === "/purchases/") {
        if (chip.failNextCreate !== null) {
          const status = chip.failNextCreate;
          chip.failNextCreate = null;
          return json({ error: "nope" }, status);
        }
        const input = body as {
          reference: string;
          due: number;
          purchase: { currency: string; products: { name: string; price: number }[] };
        };
        const id = crypto.randomUUID();
        const purchase: FakePurchase = {
          id,
          status: "created",
          reference: input.reference,
          checkout_url: `https://gate.chip-in.asia/p/${id}/`,
          is_test: chip.testMode,
          due: input.due,
          purchase: {
            total: input.purchase.products.reduce((sum, product) => sum + product.price, 0),
            currency: input.purchase.currency,
            products: input.purchase.products,
          },
          payment: null,
        };
        chip.purchases.set(id, purchase);
        return json(purchase, 201);
      }

      const match = /^\/purchases\/([^/]+)\/(cancel\/)?$/.exec(path);
      const purchase = match?.[1] ? chip.purchases.get(match[1]) : undefined;
      if (!match || !purchase) return json({ error: "not found" }, 404);
      if (request.method === "GET" && !match[2]) return json(purchase);
      if (request.method === "POST" && match[2]) {
        if (chip.cancelStatus !== null) return json({ error: "no" }, chip.cancelStatus);
        if (purchase.status === "paid") return json({ error: "paid" }, 400);
        purchase.status = "cancelled";
        return json(purchase);
      }
      return json({ error: "unexpected" }, 400);
    },

    byReference(reference) {
      const found = [...chip.purchases.values()].find((p) => p.reference === reference);
      if (!found) throw new Error(`No purchase for ${reference}`);
      return found;
    },

    pay(id, overrides = {}) {
      const purchase = chip.purchases.get(id);
      if (!purchase) throw new Error(`No purchase ${id}`);
      purchase.status = "paid";
      if (overrides.currency) purchase.purchase.currency = overrides.currency;
      purchase.payment = {
        amount: overrides.amount ?? purchase.purchase.total,
        fee_amount: overrides.fee ?? 0,
        paid_on: Math.floor(Date.now() / 1000),
      };
    },

    async sign(body) {
      return toBase64(
        await crypto.subtle.sign(
          "RSASSA-PKCS1-v1_5",
          keys.privateKey,
          new TextEncoder().encode(body),
        ),
      );
    },

    async callback(id, eventType = "purchase.paid", signature) {
      const purchase = chip.purchases.get(id);
      const body = JSON.stringify({ ...purchase, event_type: eventType });
      return new Request("https://lensarent.test/api/webhooks/chip", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-signature": signature ?? (await chip.sign(body)),
        },
        body,
      });
    },
  };
  return chip;
}
