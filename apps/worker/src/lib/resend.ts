/**
 * Email through Resend's REST API (https://resend.com/docs/api-reference/emails/send-email):
 * `POST https://api.resend.com/emails` with `Authorization: Bearer <key>` and a JSON body
 * of `from`, `to`, `subject`, `html`, `text`. The `Idempotency-Key` header makes a retry
 * of the same outbox message a no-op on Resend's side for 24 hours.
 */
export const RESEND_API = "https://api.resend.com/emails";
const TIMEOUT_MS = 10_000;

export interface Email {
  to: string;
  subject: string;
  text: string;
  html: string;
  idempotencyKey: string;
}

/** `retryable` false: Resend refused the message itself; sending it again will not help. */
export class EmailSendError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "EmailSendError";
  }
}

export interface Mailer {
  send(email: Email): Promise<void>;
}

export function createResendMailer(options: {
  apiKey: string;
  from: string;
  fetch?: typeof fetch;
}): Mailer {
  const fetcher = options.fetch ?? ((input, init) => fetch(input, init));
  return {
    async send(email) {
      let response: Response;
      try {
        response = await fetcher(RESEND_API, {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            "content-type": "application/json",
            "idempotency-key": email.idempotencyKey,
          },
          body: JSON.stringify({
            from: options.from,
            to: [email.to],
            subject: email.subject,
            text: email.text,
            html: email.html,
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch {
        throw new EmailSendError("Resend could not be reached", true);
      }
      await response.body?.cancel();
      if (response.ok) return;
      const retryable = response.status === 429 || response.status >= 500;
      throw new EmailSendError(`Resend answered HTTP ${response.status.toString()}`, retryable);
    },
  };
}
