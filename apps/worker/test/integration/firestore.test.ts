import { describe, expect, it } from "vitest";
import type { Firestore } from "../../src/lib/firestore";
import {
  createDoc,
  deleteDoc,
  increment,
  serverTimestamp,
  setDoc,
  updateDoc,
} from "../../src/lib/firestore";
import { FirestoreValueError } from "../../src/lib/firestoreValues";
import { emulatorDb, uniqueId } from "../helpers";

const db = emulatorDb();

describe("documents", () => {
  it("stores and reads back every supported value type", async () => {
    const path = `itDocs/${uniqueId("types")}`;
    const data = {
      refCode: "PK-7F3K9Q",
      totalPayableSen: 16900,
      discountSen: 0,
      pickupAt: new Date("2026-12-24T12:00:00.000Z"),
      holdExpiresAt: null,
      confirmed: false,
      flags: ["first-time"],
      priceBreakdown: { rentalSen: 6900, lines: [{ code: "CPL", qty: 1 }] },
    };

    await db.commit([createDoc(path, { ...data, createdAt: serverTimestamp() })]);
    const snapshot = await db.get(path);

    expect(snapshot.exists).toBe(true);
    expect(snapshot.path).toBe(path);
    expect(snapshot.id).toBe(path.split("/")[1]);
    expect(snapshot.updateTime).toEqual(expect.any(String));
    expect(snapshot.createTime).toEqual(expect.any(String));
    const { createdAt, ...rest } = snapshot.data!;
    expect(rest).toEqual(data);
    expect(createdAt).toBeInstanceOf(Date);
    expect(Math.abs((createdAt as Date).getTime() - Date.now())).toBeLessThan(60_000);
  });

  it("reports a missing document without failing", async () => {
    const snapshot = await db.get(`itDocs/${uniqueId("missing")}`);
    expect(snapshot).toMatchObject({ exists: false, data: undefined, updateTime: undefined });
  });

  it("refuses to create a document that already exists", async () => {
    const path = `itDocs/${uniqueId("dup")}`;
    await db.commit([createDoc(path, { n: 1 })]);
    await expect(db.commit([createDoc(path, { n: 2 })])).rejects.toMatchObject({
      code: "ALREADY_EXISTS",
    });
    expect((await db.get(path)).data).toEqual({ n: 1 });
  });

  it("replaces a document with setDoc and merges with updateDoc", async () => {
    const path = `itDocs/${uniqueId("write")}`;
    await db.commit([setDoc(path, { a: 1, b: 2 })]);
    await db.commit([setDoc(path, { a: 10 })]);
    expect((await db.get(path)).data).toEqual({ a: 10 });

    await db.commit([updateDoc(path, { b: 20, nested: { x: 1 } })]);
    expect((await db.get(path)).data).toEqual({ a: 10, b: 20, nested: { x: 1 } });
  });

  it("refuses to update a document that does not exist", async () => {
    await expect(
      db.commit([updateDoc(`itDocs/${uniqueId("ghost")}`, { a: 1 })]),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects an update based on a stale read", async () => {
    const path = `itDocs/${uniqueId("stale")}`;
    await db.commit([createDoc(path, { status: "pending_payment" })]);
    const firstRead = await db.get(path);

    await db.commit([
      updateDoc(path, { status: "confirmed" }, { updateTime: firstRead.updateTime! }),
    ]);
    await expect(
      db.commit([updateDoc(path, { status: "cancelled" }, { updateTime: firstRead.updateTime! })]),
    ).rejects.toMatchObject({ code: "FAILED_PRECONDITION" });
    expect((await db.get(path)).data).toEqual({ status: "confirmed" });
  });

  it("applies server-side increments, alone or with other fields", async () => {
    const path = `itDocs/${uniqueId("inc")}`;
    await db.commit([createDoc(path, { attempts: 0, status: "pending" })]);

    await db.commit([updateDoc(path, { attempts: increment(1) })]);
    await db.commit([updateDoc(path, { attempts: increment(2), status: "failed" })]);

    expect((await db.get(path)).data).toEqual({ attempts: 3, status: "failed" });
  });

  it("deletes documents, optionally only if they exist", async () => {
    const path = `itDocs/${uniqueId("del")}`;
    await db.commit([createDoc(path, { a: 1 })]);
    await db.commit([deleteDoc(path, { exists: true })]);
    expect((await db.get(path)).exists).toBe(false);

    await db.commit([deleteDoc(path)]); // deleting nothing is fine
    await expect(db.commit([deleteDoc(path, { exists: true })])).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("never sends a float to Firestore", async () => {
    await expect(
      db.commit([createDoc(`itDocs/${uniqueId("float")}`, { amountSen: 69.5 })]),
    ).rejects.toThrow(FirestoreValueError);
  });
});

describe("atomic commits", () => {
  it("applies none of the writes when one precondition fails", async () => {
    const taken = `itDocs/${uniqueId("taken")}`;
    const fresh = `itDocs/${uniqueId("fresh")}`;
    const other = `itDocs/${uniqueId("other")}`;
    await db.commit([createDoc(taken, { owner: "first" })]);

    await expect(
      db.commit([
        createDoc(fresh, { owner: "second" }),
        setDoc(other, { owner: "second" }),
        createDoc(taken, { owner: "second" }),
      ]),
    ).rejects.toMatchObject({ code: "ALREADY_EXISTS" });

    const [freshDoc, otherDoc, takenDoc] = await db.getAll([fresh, other, taken]);
    expect(freshDoc!.exists).toBe(false);
    expect(otherDoc!.exists).toBe(false);
    expect(takenDoc!.data).toEqual({ owner: "first" });
  });
});

describe("getAll", () => {
  it("returns results in the order asked, including missing documents", async () => {
    const a = `itDocs/${uniqueId("a")}`;
    const b = `itDocs/${uniqueId("b")}`;
    const missing = `itDocs/${uniqueId("none")}`;
    await db.commit([createDoc(a, { v: "a" }), createDoc(b, { v: "b" })]);

    const snapshots = await db.getAll([b, missing, a]);
    expect(snapshots.map((snapshot) => snapshot.path)).toEqual([b, missing, a]);
    expect(snapshots.map((snapshot) => snapshot.data)).toEqual([{ v: "b" }, undefined, { v: "a" }]);
  });
});

describe("queries", () => {
  it("filters, orders and limits", async () => {
    const run = uniqueId("run");
    await db.commit(
      [5, 1, 4, 2, 3].map((n) =>
        createDoc(`itQuery/${run}-${n.toString()}`, {
          run,
          n,
          status: n % 2 === 0 ? "even" : "odd",
          at: new Date(Date.UTC(2026, 11, n)),
        }),
      ),
    );

    const ascending = await db.query({
      collection: "itQuery",
      where: [["run", "==", run]],
      orderBy: [["n", "asc"]],
      limit: 10,
    });
    expect(ascending.map((snapshot) => snapshot.data!.n)).toEqual([1, 2, 3, 4, 5]);

    const topTwoOdd = await db.query({
      collection: "itQuery",
      where: [
        ["run", "==", run],
        ["status", "==", "odd"],
      ],
      orderBy: [["n", "desc"]],
      limit: 2,
    });
    expect(topTwoOdd.map((snapshot) => snapshot.data!.n)).toEqual([5, 3]);

    const dueBefore = await db.query({
      collection: "itQuery",
      where: [
        ["run", "==", run],
        ["at", "<=", new Date(Date.UTC(2026, 11, 2))],
      ],
      limit: 10,
    });
    expect(dueBefore.map((snapshot) => snapshot.data!.n).sort()).toEqual([1, 2]);

    const anyOf = await db.query({
      collection: "itQuery",
      where: [
        ["run", "==", run],
        ["n", "in", [2, 4, 9]],
      ],
      limit: 10,
    });
    expect(anyOf.map((snapshot) => snapshot.data!.n).sort()).toEqual([2, 4]);
  });

  it("returns an empty list when nothing matches", async () => {
    await expect(
      db.query({ collection: "itQuery", where: [["run", "==", uniqueId("nobody")]], limit: 5 }),
    ).resolves.toEqual([]);
  });
});

describe("webhook idempotency (webhookEvents/{provider}_{eventKey})", () => {
  it("lets the same event be recorded only once", async () => {
    const path = `webhookEvents/chip_${uniqueId("evt")}`;
    const record = () =>
      db.commit([createDoc(path, { provider: "chip", receivedAt: serverTimestamp() })]);

    await record();
    await expect(record()).rejects.toMatchObject({ code: "ALREADY_EXISTS" });
  });

  it("lets exactly one of ten simultaneous deliveries through", async () => {
    const path = `webhookEvents/chip_${uniqueId("evt")}`;
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, index) =>
        db.commit([createDoc(path, { provider: "chip", delivery: index })]),
      ),
    );

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    for (const result of results) {
      if (result.status === "rejected") {
        expect(result.reason).toMatchObject({ code: "ALREADY_EXISTS" });
      }
    }
  });
});

describe("transactions", () => {
  it("reads and writes atomically and returns the function's result", async () => {
    const from = `itTx/${uniqueId("from")}`;
    const to = `itTx/${uniqueId("to")}`;
    await db.commit([createDoc(from, { balanceSen: 10000 }), createDoc(to, { balanceSen: 0 })]);

    const moved = await db.runTransaction(async (tx) => {
      const [source, target] = await tx.getAll([from, to]);
      const amount = 2500;
      tx.write(
        updateDoc(from, { balanceSen: (source!.data!.balanceSen as number) - amount }),
        updateDoc(to, { balanceSen: (target!.data!.balanceSen as number) + amount }),
      );
      return amount;
    });

    expect(moved).toBe(2500);
    const [source, target] = await db.getAll([from, to]);
    expect(source!.data).toEqual({ balanceSen: 7500 });
    expect(target!.data).toEqual({ balanceSen: 2500 });
  });

  it("writes nothing when the function throws", async () => {
    const path = `itTx/${uniqueId("abort")}`;
    await db.commit([createDoc(path, { status: "confirmed" })]);

    await expect(
      db.runTransaction(async (tx) => {
        await tx.get(path);
        tx.write(updateDoc(path, { status: "completed" }));
        throw new Error("deposit balance is not zero");
      }),
    ).rejects.toThrow("deposit balance is not zero");

    expect((await db.get(path)).data).toEqual({ status: "confirmed" });
  });

  it("can query inside a transaction", async () => {
    const run = uniqueId("txq");
    await db.commit([createDoc(`itTx/${run}`, { run, amountSen: 10000 })]);

    const total = await db.runTransaction(async (tx) => {
      const found = await tx.query({ collection: "itTx", where: [["run", "==", run]], limit: 10 });
      return found.reduce((sum, snapshot) => sum + (snapshot.data!.amountSen as number), 0);
    });
    expect(total).toBe(10000);
  });
});

/** The receipt numbering Fasa 2 will use: R-{year}-{00001…}, one counter document per year. */
async function nextReceiptNumber(client: Firestore, counterPath: string): Promise<number> {
  return client.runTransaction(
    async (tx) => {
      const counter = await tx.get(counterPath);
      const next = ((counter.data?.lastNumber as number | undefined) ?? 0) + 1;
      tx.write(setDoc(counterPath, { lastNumber: next }));
      return next;
    },
    { maxAttempts: 25 },
  );
}

describe("receipt counters (receiptCounters/{year})", () => {
  it("hands out ten unique, sequential numbers to ten simultaneous callers", async () => {
    const counterPath = `receiptCounters/${uniqueId("2026")}`;

    const numbers = await Promise.all(
      Array.from({ length: 10 }, () => nextReceiptNumber(db, counterPath)),
    );

    expect([...numbers].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect((await db.get(counterPath)).data).toEqual({ lastNumber: 10 });
  });
});
