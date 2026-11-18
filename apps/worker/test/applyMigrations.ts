import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Idempotent: applied migrations are recorded in the d1_migrations table.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
