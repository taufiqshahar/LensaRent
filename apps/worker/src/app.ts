import type { Env } from "./lib/env";
import { loadConfig } from "./lib/env";
import { errorResponse } from "./lib/http";
import { createLogger } from "./lib/logger";
import type { Route } from "./router";
import { createRouter, healthHandler } from "./router";
import {
  currentAdminHandler,
  exportLeadsHandler,
  listLeadsHandler,
  updateLeadHandler,
} from "./routes/adminLeads";
import {
  availabilityHandler,
  bookingConfigHandler,
  holdHandler,
  lookupHandler,
  quoteHandler,
} from "./routes/bookings";
import { createLeadHandler } from "./routes/leads";
import { chipWebhookHandler } from "./routes/webhooks";
import type { ServicesFactory } from "./services";
import { createServices } from "./services";

export const routes: readonly Route[] = [
  { method: "GET", path: "/api/health", handler: healthHandler },
  { method: "POST", path: "/api/leads", handler: createLeadHandler },
  { method: "GET", path: "/api/config", handler: bookingConfigHandler },
  { method: "GET", path: "/api/availability", handler: availabilityHandler },
  { method: "POST", path: "/api/quote", handler: quoteHandler },
  { method: "POST", path: "/api/bookings/hold", handler: holdHandler },
  { method: "GET", path: "/api/bookings/lookup", handler: lookupHandler },
  { method: "POST", path: "/api/webhooks/chip", handler: chipWebhookHandler },
  { method: "GET", path: "/api/admin/me", handler: currentAdminHandler },
  { method: "GET", path: "/api/admin/leads", handler: listLeadsHandler },
  { method: "GET", path: "/api/admin/leads/export", handler: exportLeadsHandler },
  { method: "PUT", path: "/api/admin/leads/:id", handler: updateLeadHandler },
];

/** Builds the Worker. Tests pass their own services factory; production uses the real one. */
export function createApp(makeServices: ServicesFactory = createServices) {
  const router = createRouter(routes);

  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const url = new URL(request.url);

      // Defensive: run_worker_first should only send /api/* here.
      if (!url.pathname.startsWith("/api/")) {
        return env.ASSETS ? env.ASSETS.fetch(request) : errorResponse("NOT_FOUND");
      }

      const logger = createLogger({ environment: env.ENVIRONMENT ?? "unknown" });
      try {
        const config = loadConfig(env);
        return await router.handle(request, config, logger, makeServices(config, env));
      } catch (error) {
        // The caller gets a generic message; the detail goes to the (redacted) log only.
        logger.error("request.failed", { method: request.method, path: url.pathname, error });
        return errorResponse("INTERNAL_ERROR");
      }
    },
  } satisfies ExportedHandler<Env>;
}
