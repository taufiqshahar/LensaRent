import type { Env } from "./lib/env";
import { loadConfig } from "./lib/env";
import { errorResponse } from "./lib/http";
import { createLogger } from "./lib/logger";
import type { Route } from "./router";
import { createRouter, healthHandler } from "./router";
import { exportLeadsHandler, listLeadsHandler, updateLeadHandler } from "./routes/adminLeads";
import { currentSessionHandler, loginHandler, logoutHandler } from "./routes/adminSession";
import { createLeadHandler } from "./routes/leads";
import type { ServicesFactory } from "./services";
import { createServices } from "./services";

export const routes: readonly Route[] = [
  { method: "GET", path: "/api/health", handler: healthHandler },
  { method: "POST", path: "/api/leads", handler: createLeadHandler },
  { method: "POST", path: "/api/admin/session", handler: loginHandler },
  { method: "GET", path: "/api/admin/session", handler: currentSessionHandler },
  { method: "DELETE", path: "/api/admin/session", handler: logoutHandler },
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
