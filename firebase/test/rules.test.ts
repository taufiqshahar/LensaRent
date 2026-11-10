import { readFileSync } from "node:fs";
import type { RulesTestContext, RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { assertFails, initializeTestEnvironment } from "@firebase/rules-unit-testing";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
} from "firebase/firestore";
import { deleteObject, getBytes, listAll, ref, uploadString } from "firebase/storage";
import { afterAll, beforeAll, describe, it } from "vitest";

/**
 * Security Rules are deny-all: no client may read or write Firestore or Storage directly,
 * whoever they are. All access goes through the Worker, whose service account bypasses
 * rules. These tests prove the "whoever they are" part, including for a signed-in admin.
 */
const COLLECTIONS = [
  "settings",
  "units",
  "customers",
  "bookings",
  "availabilityLocks",
  "bookingEvents",
  "payments",
  "ledgerEntries",
  "webhookEvents",
  "notificationsOutbox",
  "receiptCounters",
  "leads",
  "auditLogs",
  "anythingElse",
] as const;

let environment: RulesTestEnvironment;

const callers: [label: string, context: () => RulesTestContext][] = [
  ["a visitor who is not signed in", () => environment.unauthenticatedContext()],
  ["a signed-in user without the admin claim", () => environment.authenticatedContext("user-1")],
  [
    "a signed-in admin (admin claim set)",
    () => environment.authenticatedContext("admin-1", { admin: true }),
  ],
];

beforeAll(async () => {
  environment = await initializeTestEnvironment({
    projectId: "demo-lensarent",
    firestore: {
      rules: readFileSync(new URL("../firestore.rules", import.meta.url), "utf8"),
      host: "127.0.0.1",
      port: 8080,
    },
    storage: {
      rules: readFileSync(new URL("../storage.rules", import.meta.url), "utf8"),
      host: "127.0.0.1",
      port: 9199,
    },
  });

  // Seed one document per collection (bypassing rules) so reads have something to find.
  await environment.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await Promise.all(
      COLLECTIONS.map((name) => setDoc(doc(db, name, "rules-seed"), { seeded: true })),
    );
    await uploadString(ref(context.storage(), "handover/rules-seed/checkout/photo.jpg"), "seed");
  });
});

afterAll(async () => {
  await environment.cleanup();
});

describe.each(callers)("Firestore rules for %s", (_label, context) => {
  describe.each(COLLECTIONS)("collection %s", (name) => {
    it("cannot read a document", async () => {
      await assertFails(getDoc(doc(context().firestore(), name, "rules-seed")));
    });

    it("cannot list or query documents", async () => {
      await assertFails(getDocs(collection(context().firestore(), name)));
    });

    it("cannot create a document", async () => {
      const db = context().firestore();
      await assertFails(setDoc(doc(db, name, "rules-new"), { created: true }));
      await assertFails(addDoc(collection(db, name), { created: true }));
    });

    it("cannot update a document", async () => {
      await assertFails(
        updateDoc(doc(context().firestore(), name, "rules-seed"), { seeded: false }),
      );
    });

    it("cannot delete a document", async () => {
      await assertFails(deleteDoc(doc(context().firestore(), name, "rules-seed")));
    });
  });

  it("cannot reach a nested collection either", async () => {
    await assertFails(getDoc(doc(context().firestore(), "bookings/rules-seed/private/data")));
  });
});

describe.each(callers)("Storage rules for %s", (_label, context) => {
  const photoPath = "handover/rules-seed/checkout/photo.jpg";

  it("cannot download a handover photo", async () => {
    await assertFails(getBytes(ref(context().storage(), photoPath)));
  });

  it("cannot list handover photos", async () => {
    await assertFails(listAll(ref(context().storage(), "handover/rules-seed/checkout")));
  });

  it("cannot upload a file", async () => {
    await assertFails(
      uploadString(ref(context().storage(), "handover/rules-seed/return/new.jpg"), "data"),
    );
  });

  it("cannot delete a file", async () => {
    await assertFails(deleteObject(ref(context().storage(), photoPath)));
  });
});
