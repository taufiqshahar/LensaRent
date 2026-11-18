import type { Env } from "./lib/env";
import { loadConfig } from "./lib/env";
import { errorResponse } from "./lib/http";
import { createLogger } from "./lib/logger";
import type { Route } from "./router";
import { createRouter, healthHandler } from "./router";
import {
  bookingDetailHandler,
  cancelHandler,
  handoverHandler,
  ledgerEntryHandler,
  listBookingsHandler,
  refundHandler,
  rescheduleHandler,
  returnHandler,
  settleHandler,
  transitionHandler,
} from "./routes/adminBookings";
import {
  auditLogHandler,
  calendarHandler,
  createBlockHandler,
  createUnitHandler,
  deleteBlockHandler,
  getSettingsHandler,
  listBlocksHandler,
  listCustomersHandler,
  listUnitsHandler,
  updateCustomerHandler,
  updateSettingHandler,
  updateUnitHandler,
} from "./routes/adminFleet";
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
import { downloadPhotoHandler, uploadPhotoHandler } from "./routes/adminPhotos";
import { createLeadHandler } from "./routes/leads";
import { chipWebhookHandler } from "./routes/webhooks";
import { runScheduled } from "./scheduled";
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
  { method: "GET", path: "/api/admin/bookings", handler: listBookingsHandler },
  { method: "GET", path: "/api/admin/bookings/:id", handler: bookingDetailHandler },
  { method: "POST", path: "/api/admin/bookings/:id/transition", handler: transitionHandler },
  { method: "POST", path: "/api/admin/bookings/:id/cancel", handler: cancelHandler },
  { method: "POST", path: "/api/admin/bookings/:id/refund", handler: refundHandler },
  { method: "POST", path: "/api/admin/bookings/:id/handover", handler: handoverHandler },
  { method: "POST", path: "/api/admin/bookings/:id/return", handler: returnHandler },
  { method: "POST", path: "/api/admin/bookings/:id/settle", handler: settleHandler },
  { method: "POST", path: "/api/admin/bookings/:id/ledger", handler: ledgerEntryHandler },
  { method: "POST", path: "/api/admin/bookings/:id/reschedule", handler: rescheduleHandler },
  { method: "POST", path: "/api/admin/bookings/:id/photos", handler: uploadPhotoHandler },
  { method: "GET", path: "/api/admin/photos/:id", handler: downloadPhotoHandler },
  { method: "GET", path: "/api/admin/units", handler: listUnitsHandler },
  { method: "POST", path: "/api/admin/units", handler: createUnitHandler },
  { method: "PUT", path: "/api/admin/units/:id", handler: updateUnitHandler },
  { method: "GET", path: "/api/admin/blocks", handler: listBlocksHandler },
  { method: "POST", path: "/api/admin/blocks", handler: createBlockHandler },
  { method: "DELETE", path: "/api/admin/blocks/:id", handler: deleteBlockHandler },
  { method: "GET", path: "/api/admin/calendar", handler: calendarHandler },
  { method: "GET", path: "/api/admin/customers", handler: listCustomersHandler },
  { method: "PUT", path: "/api/admin/customers/:id", handler: updateCustomerHandler },
  { method: "GET", path: "/api/admin/settings", handler: getSettingsHandler },
  { method: "PUT", path: "/api/admin/settings/:key", handler: updateSettingHandler },
  { method: "GET", path: "/api/admin/audit-logs", handler: auditLogHandler },
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

    /** The single cron trigger (every minute): holds, overdue, emails, cleanup. */
    async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
      const logger = createLogger({ environment: env.ENVIRONMENT ?? "unknown" });
      try {
        const config = loadConfig(env);
        await runScheduled(config, makeServices(config, env), logger);
      } catch (error) {
        logger.error("cron.failed", { error });
        throw error;
      }
    },
  } satisfies ExportedHandler<Env>;
}
