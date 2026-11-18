import { newId } from "./db";

/**
 * Audit log entries. They record who did what to which record and the NAMES of the
 * fields that changed, never the values. Always run in the same batch as the change.
 * The table is append-only at the database level (triggers in migrations/0001).
 */
export interface AuditEntry {
  actor: { id: string; email: string };
  action: string;
  targetTable: string;
  targetId: string;
  changedFields?: readonly string[];
  at: Date;
}

const INSERT = `INSERT INTO audit_logs
  (id, actor_id, actor_email, action, target_table, target_id, changed_fields, at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

export function auditStatement(db: D1Database, entry: AuditEntry): D1PreparedStatement {
  return db
    .prepare(INSERT)
    .bind(
      newId(),
      entry.actor.id,
      entry.actor.email,
      entry.action,
      entry.targetTable,
      entry.targetId,
      JSON.stringify(entry.changedFields ?? []),
      entry.at.toISOString(),
    );
}

/**
 * The same entry, written only if `guardSql` (a `SELECT 1 FROM … WHERE …`) finds a row.
 * Use it next to an UPDATE that may match nothing, so no audit row exists for a change
 * that never happened.
 */
export function auditStatementIf(
  db: D1Database,
  entry: AuditEntry,
  guardSql: string,
  guardParams: readonly unknown[],
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_logs
        (id, actor_id, actor_email, action, target_table, target_id, changed_fields, at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (${guardSql})`,
    )
    .bind(
      newId(),
      entry.actor.id,
      entry.actor.email,
      entry.action,
      entry.targetTable,
      entry.targetId,
      JSON.stringify(entry.changedFields ?? []),
      entry.at.toISOString(),
      ...guardParams,
    );
}
