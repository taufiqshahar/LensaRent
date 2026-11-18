import { describe, expect, it } from "vitest";
import { EmailSendError, RESEND_API, createResendMailer } from "../../src/lib/resend";

const email = {
  to: "a@example.com",
  subject: "Hai",
  text: "Teks",
  html: "<p>Teks</p>",
  idempotencyKey: "outbox-1",
};

function mailer(respond: () => Promise<Response>, seen: Request[] = []) {
  return createResendMailer({
    apiKey: "test-resend-key",
    from: "LensaRent <tempahan@example.com>",
    fetch: (input, init) => {
      seen.push(new Request(input, init));
      return respond();
    },
  });
}

describe("createResendMailer", () => {
  it("posts the message with the key and an idempotency key", async () => {
    const seen: Request[] = [];
    await mailer(() => Promise.resolve(Response.json({ id: "e1" })), seen).send(email);
    const request = seen[0];
    expect(request?.url).toBe(RESEND_API);
    expect(request?.headers.get("authorization")).toBe("Bearer test-resend-key");
    expect(request?.headers.get("idempotency-key")).toBe("outbox-1");
    expect(await request?.json()).toEqual({
      from: "LensaRent <tempahan@example.com>",
      to: ["a@example.com"],
      subject: "Hai",
      text: "Teks",
      html: "<p>Teks</p>",
    });
  });

  it.each([
    [429, true],
    [503, true],
    [422, false],
    [401, false],
  ])("treats HTTP %i as retryable: %s", async (status, retryable) => {
    const error = await mailer(() => Promise.resolve(new Response("{}", { status })))
      .send(email)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EmailSendError);
    expect((error as EmailSendError).retryable).toBe(retryable);
  });

  it("retries when Resend cannot be reached", async () => {
    const error = await mailer(() => Promise.reject(new Error("offline")))
      .send(email)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ retryable: true });
  });
});
