import { PaymentProviderError, PaymentSignatureError } from "../lib/chip";
import { errorResponse, jsonResponse } from "../lib/http";
import { findPaymentByRef, settlePayment } from "../lib/settlement";
import type { Handler } from "../router";

/** Largest callback body accepted. A CHIP Purchase object is a few kilobytes. */
const MAX_WEBHOOK_BYTES = 64 * 1024;

/**
 * POST /api/webhooks/chip — CHIP's `success_callback` (docs/PAYMENT_AND_DEPOSIT_SPEC.md).
 *
 * 1. The RSA signature over the raw body must verify, or nothing else happens.
 * 2. Each (purchase, event) is processed once; CHIP delivers at least once.
 * 3. The callback body is not trusted for the outcome: the purchase is fetched again from
 *    the CHIP API and settled from that answer.
 *
 * Any 2xx tells CHIP to stop retrying, so a 2xx is returned only once the event is fully
 * handled (or is one we deliberately ignore). Errors get a non-2xx and are retried.
 */
export const chipWebhookHandler: Handler = async ({ request, services, config, logger }) => {
  const provider = services.payments;
  if (!provider) return errorResponse("NOT_FOUND");
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_WEBHOOK_BYTES) return errorResponse("PAYLOAD_TOO_LARGE");

  let event;
  try {
    event = await provider.verifyAndParseWebhook(request);
  } catch (error) {
    if (error instanceof PaymentSignatureError) {
      logger.warn("webhook.bad_signature", {});
      return errorResponse("UNAUTHENTICATED");
    }
    throw error;
  }

  const eventKey = `${event.providerRef}:${event.eventType}`;
  const seen = await services.db
    .prepare("SELECT result FROM webhook_events WHERE provider = 'chip' AND event_key = ?")
    .bind(eventKey)
    .first<{ result: string }>();
  if (seen) return jsonResponse({ ok: true, result: "already_processed" });

  if (event.eventType !== "purchase.paid") {
    return jsonResponse({ ok: true, result: "ignored" });
  }

  const payment = await findPaymentByRef(services.db, event.providerRef);
  if (!payment) {
    // Not ours, or our payment row was never written. CHIP retries; the logs show it.
    logger.error("webhook.unknown_purchase", {});
    return errorResponse("NOT_FOUND");
  }

  let state;
  try {
    state = await provider.fetchPayment(event.providerRef);
  } catch (error) {
    if (error instanceof PaymentProviderError) {
      logger.warn("webhook.fetch_failed", { bookingId: payment.booking_id });
      return errorResponse("INTERNAL_ERROR");
    }
    throw error;
  }

  const now = services.now();
  const result = await settlePayment(
    {
      db: services.db,
      logger,
      production: config.environment === "production",
      alertEmails: config.alertEmails,
      now,
    },
    payment,
    state,
  );
  // A purchase CHIP says is not paid yet is not recorded, so a later delivery still counts.
  if (result !== "not_paid") {
    await services.db
      .prepare(
        `INSERT INTO webhook_events (provider, event_key, received_at, result)
         VALUES ('chip', ?, ?, ?) ON CONFLICT (provider, event_key) DO NOTHING`,
      )
      .bind(eventKey, now.toISOString(), result)
      .run();
  }
  return jsonResponse({ ok: true, result });
};
