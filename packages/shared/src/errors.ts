/**
 * Errors raised by pure domain logic. The Worker maps `code` to an HTTP status and a
 * customer-facing Bahasa Melayu message; the message here is for developers and logs only.
 */
export type DomainErrorCode =
  | "INVALID_AMOUNT"
  | "INVALID_DATE"
  | "INVALID_PERIOD"
  | "INVALID_RENTAL_DAYS"
  | "EXCEEDS_MAX_RENTAL_DAYS"
  | "UNKNOWN_ADD_ON"
  | "INVALID_ADD_ON_QTY"
  | "ADD_ON_QTY_EXCEEDED"
  | "DUPLICATE_ADD_ON"
  | "UNKNOWN_LOCATION"
  | "INVALID_DISCOUNT"
  | "INVALID_SETTINGS";

export class DomainError extends Error {
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode, message: string) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}
