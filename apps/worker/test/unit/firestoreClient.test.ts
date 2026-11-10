import { describe, expect, it, vi } from "vitest";
import {
  Firestore,
  FirestoreError,
  createDoc,
  createFirestore,
  deleteDoc,
  isFirestoreError,
  serverTimestamp,
  updateDoc,
} from "../../src/lib/firestore";
import { generateTestServiceAccountKey } from "../helpers";

const tokenProvider = { getToken: () => Promise.resolve("access-token") };

function clientWith(fetchMock: typeof fetch, timeoutMs?: number): Firestore {
  return new Firestore({
    projectId: "lensarent-production",
    tokenProvider,
    fetch: fetchMock,
    ...(timeoutMs !== undefined && { timeoutMs }),
  });
}

describe("Firestore REST requests", () => {
  it("sends writes to the production endpoint with the bearer token", async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json({ writeResults: [] })),
    );
    const db = clientWith(fetchMock);

    await db.commit([
      createDoc("bookings/b1", { status: "pending_payment", createdAt: serverTimestamp() }),
      updateDoc(
        "units/u1",
        { status: "maintenance" },
        { updateTime: "2026-12-24T00:00:00.000000Z" },
      ),
      deleteDoc("availabilityLocks/u1_2026-12-24"),
      deleteDoc("availabilityLocks/u1_2026-12-25", { exists: true }),
    ]);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      "https://firestore.googleapis.com/v1/projects/lensarent-production/databases/(default)/documents:commit",
    );
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer access-token");

    const root = "projects/lensarent-production/databases/(default)/documents";
    expect(JSON.parse(init?.body as string)).toEqual({
      writes: [
        {
          update: {
            name: `${root}/bookings/b1`,
            fields: { status: { stringValue: "pending_payment" } },
          },
          updateTransforms: [{ fieldPath: "createdAt", setToServerValue: "REQUEST_TIME" }],
          currentDocument: { exists: false },
        },
        {
          update: { name: `${root}/units/u1`, fields: { status: { stringValue: "maintenance" } } },
          updateMask: { fieldPaths: ["status"] },
          currentDocument: { updateTime: "2026-12-24T00:00:00.000000Z" },
        },
        { delete: `${root}/availabilityLocks/u1_2026-12-24` },
        { delete: `${root}/availabilityLocks/u1_2026-12-25`, currentDocument: { exists: true } },
      ],
    });
  });

  it("does not call Firestore for an empty commit or an empty read", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const db = clientWith(fetchMock);
    await db.commit([]);
    await expect(db.getAll([])).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["an odd number of segments", "bookings"],
    ["an empty segment", "bookings//x"],
    ["a parent reference", "bookings/.."],
    ["a leading slash", "/bookings/x"],
    ["an empty path", ""],
  ])("rejects a document path with %s", async (_label, path) => {
    const fetchMock = vi.fn<typeof fetch>();
    const db = clientWith(fetchMock);
    await expect(db.get(path)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(db.commit([deleteDoc(path)])).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([0, 1001, 1.5])("rejects a query limit of %d", async (limit) => {
    const db = clientWith(vi.fn<typeof fetch>());
    await expect(db.query({ collection: "bookings", limit })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });

  it("rejects an invalid collection id", async () => {
    const db = clientWith(vi.fn<typeof fetch>());
    await expect(db.query({ collection: "a/b", limit: 1 })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });
});

describe("Firestore error mapping", () => {
  it.each([
    [
      409,
      { error: { code: 409, status: "ALREADY_EXISTS", message: "Document already exists" } },
      "ALREADY_EXISTS",
      "Document already exists",
    ],
    [
      400,
      { error: { code: 400, status: "FAILED_PRECONDITION", message: "stale" } },
      "FAILED_PRECONDITION",
      "stale",
    ],
    [
      409,
      [{ error: { code: 409, status: "ABORTED", message: "contention" } }],
      "ABORTED",
      "contention",
    ],
    [418, { error: { status: "TEAPOT" } }, "UNKNOWN", "Firestore request failed"],
    [502, undefined, "UNKNOWN", "Firestore request failed"],
  ])("maps HTTP %d to a typed error", async (status, body, code, message) => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        body === undefined
          ? new Response("<html>bad gateway</html>", { status })
          : Response.json(body, { status }),
      ),
    );
    const error = await clientWith(fetchMock)
      .commit([deleteDoc("a/b")])
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FirestoreError);
    expect(error).toMatchObject({ code, httpStatus: status, message });
    expect(isFirestoreError(error)).toBe(true);
    expect(isFirestoreError(error, "NOT_FOUND")).toBe(false);
    expect(isFirestoreError(new Error("other"))).toBe(false);
  });

  it("reports a network failure as UNAVAILABLE", async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.reject(new TypeError("connection refused")),
    );
    await expect(clientWith(fetchMock).commit([deleteDoc("a/b")])).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
  });

  it("gives up on a request that takes too long", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(init.signal?.reason as Error);
          });
        }),
    );
    await expect(clientWith(fetchMock, 20).commit([deleteDoc("a/b")])).rejects.toMatchObject({
      code: "DEADLINE_EXCEEDED",
    });
  });

  it("fails loudly if Firestore leaves a requested document out of its answer", async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json([{ readTime: "x" }])),
    );
    await expect(clientWith(fetchMock).get("a/b")).rejects.toMatchObject({ code: "INTERNAL" });
  });

  it("fails loudly if a transaction cannot be started", async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(Response.json({})));
    await expect(
      clientWith(fetchMock).runTransaction(() => Promise.resolve(1)),
    ).rejects.toMatchObject({
      code: "INTERNAL",
    });
  });
});

describe("createFirestore", () => {
  const base = { environment: "test", firebaseProjectId: "demo-lensarent" } as const;

  it("uses the emulator when a host is configured", () => {
    expect(
      createFirestore({
        ...base,
        serviceAccountJson: undefined,
        firestoreEmulatorHost: "127.0.0.1:8080",
      }),
    ).toBeInstanceOf(Firestore);
  });

  it("uses the service account otherwise", async () => {
    const { privateKeyPem } = await generateTestServiceAccountKey();
    const serviceAccountJson = JSON.stringify({
      client_email: "worker@demo-lensarent.iam.gserviceaccount.com",
      private_key: privateKeyPem,
    });
    expect(
      createFirestore({ ...base, serviceAccountJson, firestoreEmulatorHost: undefined }),
    ).toBeInstanceOf(Firestore);
  });

  it("refuses to run without any credentials", () => {
    expect(() =>
      createFirestore({ ...base, serviceAccountJson: undefined, firestoreEmulatorHost: undefined }),
    ).toThrow(FirestoreError);
  });
});
