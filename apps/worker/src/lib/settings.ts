import type { AdminEditableSetting, AllSettings } from "@lensarent/shared";
import {
  ADMIN_EDITABLE_SETTINGS,
  DEFAULT_SETTINGS,
  isAdminEditableSetting,
  parseSettingsValue,
} from "@lensarent/shared";
import type { Logger } from "./logger";

/**
 * Effective settings: the code defaults (DEFAULT_SETTINGS) with the admin-editable keys
 * overridden by rows in the `settings` table (ADR-020). A stored value that no longer
 * validates is ignored and logged, so a bad row can never take the booking flow down.
 */
export async function loadSettings(db: D1Database, logger?: Logger): Promise<AllSettings> {
  const { results } = await db
    .prepare(
      `SELECT key, value FROM settings WHERE key IN (${ADMIN_EDITABLE_SETTINGS.map(() => "?").join(", ")})`,
    )
    .bind(...ADMIN_EDITABLE_SETTINGS)
    .all<{ key: string; value: string }>();

  const settings: AllSettings = { ...DEFAULT_SETTINGS };
  for (const row of results) {
    if (!isAdminEditableSetting(row.key)) continue;
    try {
      assign(settings, row.key, parseSettingsValue(row.key, JSON.parse(row.value)));
    } catch {
      logger?.error("settings.invalid_row", { key: row.key });
    }
  }
  return settings;
}

function assign<K extends AdminEditableSetting>(
  settings: AllSettings,
  key: K,
  value: AllSettings[K],
): void {
  settings[key] = value;
}

export function saveSettingStatement(
  db: D1Database,
  key: AdminEditableSetting,
  value: unknown,
  updatedBy: string,
  now: Date,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`,
    )
    .bind(key, JSON.stringify(value), updatedBy, now.toISOString());
}
