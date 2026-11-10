import type { Env } from "./lib/env";
import { loadConfig } from "./lib/env";
import { errorResponse } from "./lib/http";
import { createLogger } from "./lib/logger";
import type { Route } from "./router";
import { createRouter, healthHandler } from "./router";

/**
 * The single Cloudflare Worker for LensaRent. Requests to /api/* arrive here; everything
 * else is served directly from static assets (see wrangler.toml).
 *
 * This Worker is the ONLY enforcement layer for data integrity. It writes to Firestore as
 * a service account, which bypasses Security Rules, so every rule about bookings, status
 * changes and the ledger has to be checked in code here before anything is written.
 */
const routes: readonly Route[] = [{ method: "GET", path: "/api/health", handler: healthHandler }];

const router = createRouter(routes);

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    // Defensive: run_worker_first should only send /api/* here.
    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS ? env.ASSETS.fetch(request) : errorResponse("NOT_FOUND");
    }

    const logger = createLogger({ environment: env.ENVIRONMENT ?? "unknown" });
    try {
      const config = loadConfig(env);
      return await router.handle(request, config, logger);
    } catch (error) {
      // The caller gets a generic message; the detail goes to the (redacted) log only.
      logger.error("request.failed", { method: request.method, path: url.pathname, error });
      return errorResponse("INTERNAL_ERROR");
    }
  },
} satisfies ExportedHandler<Env>;
