import type { AppConfig } from "./env";
import type {
  DocumentData,
  FieldTransform,
  FirestoreFields,
  FirestoreValue,
} from "./firestoreValues";
import {
  decodeFields,
  decodeValue,
  encodeDocument,
  encodeValue,
  fieldPathSegment,
} from "./firestoreValues";
import type { AccessTokenProvider } from "./googleAuth";
import {
  EmulatorTokenProvider,
  FIRESTORE_SCOPE,
  ServiceAccountTokenProvider,
  parseServiceAccount,
} from "./googleAuth";

/**
 * Firestore client over the REST API.
 *
 * The Worker authenticates as a service account, which BYPASSES Firestore Security Rules.
 * Nothing in Firestore protects the data from a mistake made here, so every invariant
 * (no double booking, valid status changes, append-only ledger) is enforced by the code
 * that builds the writes passed to `commit`.
 *
 * `commit` applies all of its writes atomically: if any precondition fails, none of them
 * are applied. That guarantee is what the booking lock pattern is built on.
 */
export type FirestoreErrorCode =
  | "ALREADY_EXISTS"
  | "NOT_FOUND"
  | "FAILED_PRECONDITION"
  | "ABORTED"
  | "INVALID_ARGUMENT"
  | "PERMISSION_DENIED"
  | "UNAUTHENTICATED"
  | "RESOURCE_EXHAUSTED"
  | "DEADLINE_EXCEEDED"
  | "UNAVAILABLE"
  | "INTERNAL"
  | "UNKNOWN";

const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set<FirestoreErrorCode>([
  "ALREADY_EXISTS",
  "NOT_FOUND",
  "FAILED_PRECONDITION",
  "ABORTED",
  "INVALID_ARGUMENT",
  "PERMISSION_DENIED",
  "UNAUTHENTICATED",
  "RESOURCE_EXHAUSTED",
  "DEADLINE_EXCEEDED",
  "UNAVAILABLE",
  "INTERNAL",
]);

export class FirestoreError extends Error {
  readonly code: FirestoreErrorCode;
  readonly httpStatus: number;

  constructor(
    code: FirestoreErrorCode,
    httpStatus: number,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "FirestoreError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export function isFirestoreError(
  error: unknown,
  code?: FirestoreErrorCode,
): error is FirestoreError {
  return error instanceof FirestoreError && (code === undefined || error.code === code);
}

export interface DocumentSnapshot {
  /** Path relative to the database root, e.g. `bookings/abc123`. */
  path: string;
  id: string;
  exists: boolean;
  /** Unvalidated: parse with a zod schema before trusting the shape. */
  data: DocumentData | undefined;
  createTime: string | undefined;
  /** Opaque version stamp; pass it back as a precondition for optimistic updates. */
  updateTime: string | undefined;
}

export interface Precondition {
  exists?: boolean;
  updateTime?: string;
}

export type Write =
  | { kind: "set"; path: string; data: DocumentData; merge: boolean; precondition?: Precondition }
  | { kind: "delete"; path: string; precondition?: Precondition };

/** Creates a document. The whole commit fails with `ALREADY_EXISTS` if it is already there. */
export function createDoc(path: string, data: DocumentData): Write {
  return { kind: "set", path, data, merge: false, precondition: { exists: false } };
}

/** Writes a document, replacing whatever was there. */
export function setDoc(path: string, data: DocumentData): Write {
  return { kind: "set", path, data, merge: false };
}

/**
 * Changes only the given top-level fields. By default the document must already exist;
 * pass `{ updateTime }` to also require that nobody changed it since it was read.
 */
export function updateDoc(
  path: string,
  data: DocumentData,
  precondition: Precondition = { exists: true },
): Write {
  return { kind: "set", path, data, merge: true, precondition };
}

/**
 * Creates the document if it is missing, otherwise changes only the given fields. Use with
 * `increment()` for counters: the new value comes back in the commit's `transformResults`.
 */
export function upsertDoc(path: string, data: DocumentData): Write {
  return { kind: "set", path, data, merge: true };
}

/** Result of one write in a commit, in the order the writes were given. */
export interface WriteResult {
  updateTime: string | undefined;
  /** Values produced by server-side transforms, in the order the transforms appear. */
  transformResults: unknown[];
}

const AUTO_ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** A random 20-character document id, the same shape Firestore generates. */
export function newDocumentId(): string {
  // 248 is the largest multiple of 62 below 256; rejecting bytes above it keeps ids uniform.
  const id: string[] = [];
  while (id.length < 20) {
    for (const byte of crypto.getRandomValues(new Uint8Array(32))) {
      if (byte < 248 && id.length < 20) id.push(AUTO_ID_ALPHABET.charAt(byte % 62));
    }
  }
  return id.join("");
}

export function deleteDoc(path: string, precondition?: Precondition): Write {
  return precondition ? { kind: "delete", path, precondition } : { kind: "delete", path };
}

export type FilterOperator = "==" | "!=" | "<" | "<=" | ">" | ">=" | "in" | "array-contains";

const FILTER_OPERATORS: Record<FilterOperator, string> = {
  "==": "EQUAL",
  "!=": "NOT_EQUAL",
  "<": "LESS_THAN",
  "<=": "LESS_THAN_OR_EQUAL",
  ">": "GREATER_THAN",
  ">=": "GREATER_THAN_OR_EQUAL",
  in: "IN",
  "array-contains": "ARRAY_CONTAINS",
};

export const MAX_QUERY_LIMIT = 1000;

export interface QuerySpec {
  /** A top-level collection id. */
  collection: string;
  where?: readonly (readonly [field: string, operator: FilterOperator, value: unknown])[];
  orderBy?: readonly (readonly [field: string, direction: "asc" | "desc"])[];
  /** Required, so no query can ever read an unbounded number of documents. */
  limit: number;
}

export interface Transaction {
  get(path: string): Promise<DocumentSnapshot>;
  getAll(paths: readonly string[]): Promise<DocumentSnapshot[]>;
  query(spec: QuerySpec): Promise<DocumentSnapshot[]>;
  /** Buffers writes; they are applied atomically when the transaction function returns. */
  write(...writes: Write[]): void;
}

export interface FirestoreOptions {
  projectId: string;
  tokenProvider: AccessTokenProvider;
  /** `host:port` of the Firestore emulator. Development and tests only. */
  emulatorHost?: string | undefined;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

interface RestDocument {
  name: string;
  fields?: FirestoreFields;
  createTime?: string;
  updateTime?: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const SEGMENT_PATTERN = /^[^/]{1,1500}$/;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class Firestore {
  readonly #tokenProvider: AccessTokenProvider;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  /** `projects/{project}/databases/(default)/documents` */
  readonly #root: string;
  readonly #baseUrl: string;

  constructor(options: FirestoreOptions) {
    this.#tokenProvider = options.tokenProvider;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#root = `projects/${options.projectId}/databases/(default)/documents`;
    const origin = options.emulatorHost
      ? `http://${options.emulatorHost}`
      : "https://firestore.googleapis.com";
    this.#baseUrl = `${origin}/v1/${this.#root}`;
  }

  async get(path: string): Promise<DocumentSnapshot> {
    const [snapshot] = await this.getAll([path]);
    if (!snapshot) throw new FirestoreError("INTERNAL", 0, "Firestore returned no result");
    return snapshot;
  }

  /** Reads several documents in one round trip. Results are in the order of `paths`. */
  getAll(paths: readonly string[]): Promise<DocumentSnapshot[]> {
    return this.#batchGet(paths, undefined);
  }

  query(spec: QuerySpec): Promise<DocumentSnapshot[]> {
    return this.#runQuery(spec, undefined);
  }

  /**
   * Applies the writes atomically: all of them, or (on any failed precondition) none.
   *
   * `ABORTED` means Firestore gave up because other writers were touching the same
   * documents, and that nothing was applied. It says nothing about the preconditions, so
   * the commit is simply sent again; the caller then gets a definite answer.
   */
  async commit(
    writes: readonly Write[],
    options: { maxAttempts?: number } = {},
  ): Promise<WriteResult[]> {
    if (writes.length === 0) return [];
    const body = { writes: writes.map((write) => this.#toRestWrite(write)) };
    const maxAttempts = options.maxAttempts ?? 4;

    for (let attempt = 1; ; attempt++) {
      try {
        const response = (await this.#post(":commit", body)) as {
          writeResults?: { updateTime?: string; transformResults?: FirestoreValue[] }[];
        };
        return (response.writeResults ?? []).map((result) => ({
          updateTime: result.updateTime,
          transformResults: (result.transformResults ?? []).map(decodeValue),
        }));
      } catch (error) {
        if (!isFirestoreError(error, "ABORTED") || attempt >= maxAttempts) throw error;
        await sleep(Math.random() * 25 * 2 ** attempt);
      }
    }
  }

  /**
   * Runs `fn` in a read-write transaction: documents it reads cannot change before its
   * writes are committed. `fn` is retried when Firestore aborts the transaction because of
   * contention, so it must be free of side effects other than `tx.write`.
   */
  async runTransaction<T>(
    fn: (tx: Transaction) => Promise<T>,
    options: { maxAttempts?: number } = {},
  ): Promise<T> {
    const maxAttempts = options.maxAttempts ?? 5;
    let previousId: string | undefined;

    for (let attempt = 1; ; attempt++) {
      const transactionId = await this.#beginTransaction(previousId);
      const writes: Write[] = [];
      let committing = false;
      try {
        const result = await fn({
          get: async (path) => {
            const [snapshot] = await this.#batchGet([path], transactionId);
            if (!snapshot) throw new FirestoreError("INTERNAL", 0, "Firestore returned no result");
            return snapshot;
          },
          getAll: (paths) => this.#batchGet(paths, transactionId),
          query: (spec) => this.#runQuery(spec, transactionId),
          write: (...added) => {
            writes.push(...added);
          },
        });
        committing = true;
        await this.#post(":commit", {
          transaction: transactionId,
          writes: writes.map((write) => this.#toRestWrite(write)),
        });
        return result;
      } catch (error) {
        // A failed commit has already ended the transaction; otherwise release its locks.
        if (!committing) await this.#rollback(transactionId);
        if (!isFirestoreError(error, "ABORTED") || attempt >= maxAttempts) throw error;
        previousId = transactionId;
        await sleep(Math.random() * 25 * 2 ** attempt);
      }
    }
  }

  // ── REST plumbing ─────────────────────────────────────────────────────────────────────

  #documentName(path: string): string {
    const segments = path.split("/");
    const valid =
      segments.length >= 2 &&
      segments.length % 2 === 0 &&
      segments.every(
        (segment) => SEGMENT_PATTERN.test(segment) && segment !== "." && segment !== "..",
      );
    if (!valid) {
      throw new FirestoreError("INVALID_ARGUMENT", 0, "Invalid document path");
    }
    return `${this.#root}/${path}`;
  }

  #toSnapshot(name: string, document: RestDocument | undefined): DocumentSnapshot {
    const path = name.slice(this.#root.length + 1);
    return {
      path,
      id: path.slice(path.lastIndexOf("/") + 1),
      exists: document !== undefined,
      data: document ? decodeFields(document.fields) : undefined,
      createTime: document?.createTime,
      updateTime: document?.updateTime,
    };
  }

  async #batchGet(
    paths: readonly string[],
    transaction: string | undefined,
  ): Promise<DocumentSnapshot[]> {
    if (paths.length === 0) return [];
    const names = paths.map((path) => this.#documentName(path));
    const response = (await this.#post(":batchGet", {
      documents: names,
      ...(transaction && { transaction }),
    })) as { found?: RestDocument; missing?: string }[];

    // The API may answer in any order; map results back to the order that was asked for.
    const byName = new Map<string, RestDocument | undefined>();
    for (const item of response) {
      if (item.found) byName.set(item.found.name, item.found);
      else if (item.missing) byName.set(item.missing, undefined);
    }
    return names.map((name) => {
      if (!byName.has(name)) {
        throw new FirestoreError("INTERNAL", 0, "Firestore omitted a requested document");
      }
      return this.#toSnapshot(name, byName.get(name));
    });
  }

  async #runQuery(spec: QuerySpec, transaction: string | undefined): Promise<DocumentSnapshot[]> {
    if (!Number.isSafeInteger(spec.limit) || spec.limit < 1 || spec.limit > MAX_QUERY_LIMIT) {
      throw new FirestoreError(
        "INVALID_ARGUMENT",
        0,
        `Query limit must be between 1 and ${MAX_QUERY_LIMIT.toString()}`,
      );
    }
    if (!SEGMENT_PATTERN.test(spec.collection)) {
      throw new FirestoreError("INVALID_ARGUMENT", 0, "Invalid collection id");
    }

    const filters = (spec.where ?? []).map(([field, operator, value]) => ({
      fieldFilter: {
        field: { fieldPath: fieldPathSegment(field) },
        op: FILTER_OPERATORS[operator],
        value: encodeValue(value),
      },
    }));
    const [firstFilter] = filters;
    const where =
      filters.length > 1 ? { compositeFilter: { op: "AND", filters } } : (firstFilter ?? undefined);

    const structuredQuery = {
      from: [{ collectionId: spec.collection }],
      ...(where && { where }),
      ...(spec.orderBy && {
        orderBy: spec.orderBy.map(([field, direction]) => ({
          field: { fieldPath: fieldPathSegment(field) },
          direction: direction === "desc" ? "DESCENDING" : "ASCENDING",
        })),
      }),
      limit: spec.limit,
    };

    const response = (await this.#post(":runQuery", {
      structuredQuery,
      ...(transaction && { transaction }),
    })) as { document?: RestDocument }[];

    return response.flatMap((item) =>
      item.document ? [this.#toSnapshot(item.document.name, item.document)] : [],
    );
  }

  #toRestWrite(write: Write): Record<string, unknown> {
    const name = this.#documentName(write.path);
    const currentDocument = write.precondition && { currentDocument: write.precondition };
    if (write.kind === "delete") return { delete: name, ...currentDocument };

    const { fields, transforms, maskPaths } = encodeDocument(write.data);
    return {
      update: { name, fields },
      ...(write.merge && { updateMask: { fieldPaths: maskPaths } }),
      ...(transforms.length > 0 && { updateTransforms: transforms satisfies FieldTransform[] }),
      ...currentDocument,
    };
  }

  async #beginTransaction(retryTransaction: string | undefined): Promise<string> {
    const response = (await this.#post(":beginTransaction", {
      options: { readWrite: retryTransaction ? { retryTransaction } : {} },
    })) as { transaction?: string };
    if (!response.transaction) {
      throw new FirestoreError("INTERNAL", 0, "Firestore did not start a transaction");
    }
    return response.transaction;
  }

  async #rollback(transaction: string): Promise<void> {
    // Best effort: an abandoned transaction expires on its own.
    await this.#post(":rollback", { transaction }).catch(() => undefined);
  }

  async #post(method: string, body: unknown): Promise<unknown> {
    const token = await this.#tokenProvider.getToken();

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${method}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (cause) {
      const timedOut = cause instanceof Error && cause.name === "TimeoutError";
      throw new FirestoreError(
        timedOut ? "DEADLINE_EXCEEDED" : "UNAVAILABLE",
        0,
        timedOut ? "Firestore request timed out" : "Firestore request failed",
        { cause },
      );
    }

    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) throw toFirestoreError(response.status, payload);
    return payload;
  }
}

function toFirestoreError(httpStatus: number, payload: unknown): FirestoreError {
  // Streaming methods (batchGet, runQuery) wrap the error in an array.
  const body: unknown = Array.isArray(payload) ? payload[0] : payload;
  const error =
    typeof body === "object" && body !== null && "error" in body
      ? (body.error as { status?: unknown; message?: unknown })
      : undefined;
  const status = typeof error?.status === "string" ? error.status : "";
  const code: FirestoreErrorCode = KNOWN_ERROR_CODES.has(status)
    ? (status as FirestoreErrorCode)
    : "UNKNOWN";
  const message = typeof error?.message === "string" ? error.message : "Firestore request failed";
  return new FirestoreError(code, httpStatus, message);
}

/** Builds the Firestore client for a request from validated configuration. */
export function createFirestore(config: AppConfig): Firestore {
  if (config.firestoreEmulatorHost !== undefined) {
    return new Firestore({
      projectId: config.firebaseProjectId,
      emulatorHost: config.firestoreEmulatorHost,
      tokenProvider: new EmulatorTokenProvider(),
    });
  }
  if (config.serviceAccountJson === undefined) {
    throw new FirestoreError("UNAUTHENTICATED", 0, "No Firestore credentials are configured");
  }
  return new Firestore({
    projectId: config.firebaseProjectId,
    tokenProvider: new ServiceAccountTokenProvider(parseServiceAccount(config.serviceAccountJson), [
      FIRESTORE_SCOPE,
    ]),
  });
}

export type { DocumentData, FirestoreValue };
export { increment, serverTimestamp } from "./firestoreValues";
