import { z } from "zod";

/**
 * Payments go through a provider adapter (master prompt §9) so CHIP can be swapped for
 * another gateway. The CHIP implementation follows the official docs and OpenAPI spec
 * (https://docs.chip-in.asia, read 18 Nov 2026), recorded in
 * docs/PAYMENT_AND_DEPOSIT_SPEC.md:
 *
 * - API `https://gate.chip-in.asia/api/v1`, `Authorization: Bearer <secret key>`; test
 *   mode is selected by the key, and purchases carry `is_test`.
 * - Amounts are integer sen. `success_callback` POSTs the Purchase JSON when it is paid.
 * - Callbacks carry `X-Signature`: base64 RSA PKCS#1 v1.5 over the SHA-256 of the RAW
 *   body, verified with the company public key from `GET /public_key/` (a JSON string).
 * - Delivery is at least once: dedupe on purchase id + event type.
 * - `due` + `purchase.due_strict` stop payment after the hold ends;
 *   `POST /purchases/{id}/cancel/` makes a purchase unpayable.
 */
export const CHIP_API = "https://gate.chip-in.asia/api/v1";
const TIMEOUT_MS = 10_000;

export interface CheckoutLine {
  name: string;
  priceSen: number;
}

export interface CheckoutInput {
  reference: string;
  customer: { email: string; fullName: string; phone: string };
  lines: readonly CheckoutLine[];
  /** Payment is refused after this moment (the end of the hold). */
  due: Date;
  successRedirect: string;
  failureRedirect: string;
  cancelRedirect: string;
  callbackUrl: string;
}

export interface Checkout {
  providerRef: string;
  checkoutUrl: string;
  isTest: boolean;
}

export interface PaymentState {
  providerRef: string;
  reference: string;
  status: string;
  paid: boolean;
  /** Purchase total as created. */
  totalSen: number;
  /** Amount actually paid, when paid. */
  paidSen: number | null;
  feeSen: number | null;
  currency: string;
  isTest: boolean;
  paidAt: Date | null;
}

export interface VerifiedPaymentEvent {
  eventType: string;
  providerRef: string;
}

export interface PaymentProvider {
  readonly name: "chip";
  createCheckout(input: CheckoutInput): Promise<Checkout>;
  /** Throws `PaymentSignatureError` unless the callback is genuine. */
  verifyAndParseWebhook(request: Request): Promise<VerifiedPaymentEvent>;
  fetchPayment(providerRef: string): Promise<PaymentState>;
  /** Makes the purchase unpayable. False when it can no longer be cancelled (e.g. paid). */
  cancel(providerRef: string): Promise<boolean>;
}

export class PaymentSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentSignatureError";
  }
}

export class PaymentProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentProviderError";
  }
}

const purchaseSchema = z.object({
  id: z.string().min(1),
  status: z.string(),
  reference: z.string().nullish(),
  checkout_url: z.string().nullish(),
  is_test: z.boolean().default(false),
  event_type: z.string().nullish(),
  purchase: z.object({
    total: z.number().int(),
    currency: z.string(),
  }),
  payment: z
    .object({
      amount: z.number().int().nullish(),
      fee_amount: z.number().int().nullish(),
      paid_on: z.number().nullish(),
    })
    .nullish(),
});
type Purchase = z.infer<typeof purchaseSchema>;

function toState(purchase: Purchase): PaymentState {
  const paid = purchase.status === "paid";
  return {
    providerRef: purchase.id,
    reference: purchase.reference ?? "",
    status: purchase.status,
    paid,
    totalSen: purchase.purchase.total,
    paidSen: paid ? (purchase.payment?.amount ?? null) : null,
    feeSen: paid ? (purchase.payment?.fee_amount ?? null) : null,
    currency: purchase.purchase.currency,
    isTest: purchase.is_test,
    paidAt: paid && purchase.payment?.paid_on ? new Date(purchase.payment.paid_on * 1000) : null,
  };
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

/** Public keys are cached per isolate as imported values, never as pending promises. */
const publicKeyCache = new Map<string, CryptoKey>();

async function importPublicKey(pem: string): Promise<CryptoKey> {
  const cached = publicKeyCache.get(pem);
  if (cached) return cached;
  const body = pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  const key = await crypto.subtle.importKey(
    "spki",
    base64ToBytes(body),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  publicKeyCache.set(pem, key);
  return key;
}

export interface ChipOptions {
  secretKey: string;
  brandId: string;
  /** Pinned public key (PEM). When absent it is fetched from `GET /public_key/`. */
  publicKeyPem?: string | undefined;
  fetch?: typeof fetch;
}

export function createChipProvider(options: ChipOptions): PaymentProvider {
  const fetcher = options.fetch ?? ((input, init) => fetch(input, init));
  let fetchedPem: string | undefined;

  const call = async (method: string, path: string, body?: unknown): Promise<Response> => {
    try {
      return await fetcher(`${CHIP_API}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${options.secretKey}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new PaymentProviderError(`CHIP ${method} ${path} failed`);
    }
  };

  const readPurchase = async (response: Response, what: string): Promise<Purchase> => {
    if (!response.ok) {
      await response.body?.cancel();
      throw new PaymentProviderError(
        `CHIP ${what} was rejected (HTTP ${response.status.toString()})`,
      );
    }
    const parsed = purchaseSchema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) throw new PaymentProviderError(`CHIP ${what} response was not understood`);
    return parsed.data;
  };

  const publicKeyPem = async (): Promise<string> => {
    if (options.publicKeyPem) return options.publicKeyPem;
    if (fetchedPem) return fetchedPem;
    const response = await call("GET", "/public_key/");
    if (!response.ok) {
      await response.body?.cancel();
      throw new PaymentProviderError("CHIP public key could not be fetched");
    }
    // The body is a JSON-encoded string, not a bare PEM (see the docs warning).
    const pem: unknown = await response.json().catch(() => undefined);
    if (typeof pem !== "string" || !pem.includes("PUBLIC KEY")) {
      throw new PaymentProviderError("CHIP public key response was not understood");
    }
    fetchedPem = pem;
    return pem;
  };

  return {
    name: "chip",

    async createCheckout(input) {
      const response = await call("POST", "/purchases/", {
        brand_id: options.brandId,
        reference: input.reference,
        client: {
          email: input.customer.email,
          full_name: input.customer.fullName,
          phone: input.customer.phone,
        },
        purchase: {
          currency: "MYR",
          language: "ms",
          timezone: "Asia/Kuala_Lumpur",
          due_strict: true,
          // `quantity` defaults to 1; every line is one item at its full price.
          products: input.lines.map((line) => ({ name: line.name, price: line.priceSen })),
        },
        due: Math.floor(input.due.getTime() / 1000),
        send_receipt: false,
        success_redirect: input.successRedirect,
        failure_redirect: input.failureRedirect,
        cancel_redirect: input.cancelRedirect,
        success_callback: input.callbackUrl,
      });
      const purchase = await readPurchase(response, "purchase creation");
      if (!purchase.checkout_url) throw new PaymentProviderError("CHIP returned no checkout URL");
      return {
        providerRef: purchase.id,
        checkoutUrl: purchase.checkout_url,
        isTest: purchase.is_test,
      };
    },

    async verifyAndParseWebhook(request) {
      const signature = request.headers.get("x-signature");
      if (!signature) throw new PaymentSignatureError("Missing X-Signature");
      const raw = await request.arrayBuffer();
      let valid: boolean;
      try {
        valid = await crypto.subtle.verify(
          "RSASSA-PKCS1-v1_5",
          await importPublicKey(await publicKeyPem()),
          base64ToBytes(signature),
          raw,
        );
      } catch (error) {
        if (error instanceof PaymentProviderError) throw error;
        valid = false;
      }
      if (!valid) throw new PaymentSignatureError("Invalid X-Signature");

      let json: unknown;
      try {
        json = JSON.parse(new TextDecoder().decode(raw));
      } catch {
        throw new PaymentSignatureError("Signed body is not JSON");
      }
      const parsed = purchaseSchema.safeParse(json);
      if (!parsed.success) throw new PaymentSignatureError("Signed body is not a purchase");
      return {
        eventType: parsed.data.event_type ?? "purchase.paid",
        providerRef: parsed.data.id,
      };
    },

    async fetchPayment(providerRef) {
      if (!/^[A-Za-z0-9-]{1,100}$/.test(providerRef)) {
        throw new PaymentProviderError("Invalid purchase id");
      }
      return toState(
        await readPurchase(await call("GET", `/purchases/${providerRef}/`), "purchase lookup"),
      );
    },

    async cancel(providerRef) {
      if (!/^[A-Za-z0-9-]{1,100}$/.test(providerRef)) {
        throw new PaymentProviderError("Invalid purchase id");
      }
      const response = await call("POST", `/purchases/${providerRef}/cancel/`);
      if (response.ok) {
        await response.body?.cancel();
        return true;
      }
      await response.body?.cancel();
      if (response.status >= 400 && response.status < 500) return false;
      throw new PaymentProviderError(`CHIP cancel failed (HTTP ${response.status.toString()})`);
    },
  };
}
