import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Idempotent: applied migrations are recorded in the d1_migrations table.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// The fixture fleet: two active units, shared by every test file. Holds pick from ALL
// active units, so tests must never create another ACTIVE unit (use 'maintenance' or
// 'retired'), or the "exactly N winners" race tests would break.
const at = "2026-01-01T00:00:00.000Z";
await env.DB.batch(
  ["fixture-unit-a", "fixture-unit-b"].map((id, index) =>
    env.DB.prepare(
      `INSERT INTO units (id, name, model, status, sort_order, created_at, updated_at)
       VALUES (?, ?, 'DJI Osmo Pocket 4P', 'active', ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
    ).bind(id, `Unit ${(index + 1).toString()}`, index, at, at),
  ),
);
