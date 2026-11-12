import type { Write } from "./firestore";
import { createDoc, newDocumentId, serverTimestamp } from "./firestore";

/**
 * Audit log entries (`auditLogs/{logId}`). They record who did what to which record and
 * the NAMES of the fields that changed, never the values, so no personal data is copied.
 * Always committed in the same commit as the change they describe.
 */
export interface AuditEntry {
  actorId: string;
  action: string;
  targetCollection: string;
  targetId: string;
  changedFields?: readonly string[];
}

export function auditWrite(entry: AuditEntry): Write {
  return createDoc(`auditLogs/${newDocumentId()}`, {
    actorId: entry.actorId,
    action: entry.action,
    targetCollection: entry.targetCollection,
    targetId: entry.targetId,
    changedFields: [...(entry.changedFields ?? [])],
    at: serverTimestamp(),
  });
}
