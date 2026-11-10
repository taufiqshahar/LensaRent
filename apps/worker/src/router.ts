import type { AppConfig } from "./lib/env";
import { errorResponse, jsonResponse } from "./lib/http";
import type { Logger } from "./lib/logger";

export interface RequestContext {
  request: Request;
  url: URL;
  params: Readonly<Record<string, string | undefined>>;
  config: AppConfig;
  logger: Logger;
}

export type Handler = (context: RequestContext) => Response | Promise<Response>;

export interface Route {
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** URLPattern pathname, e.g. `/api/admin/bookings/:id/transition`. */
  path: string;
  handler: Handler;
}

interface CompiledRoute extends Route {
  pattern: URLPattern;
}

export interface Router {
  handle(request: Request, config: AppConfig, logger: Logger): Promise<Response>;
}

export function createRouter(routes: readonly Route[]): Router {
  const compiled: CompiledRoute[] = routes.map((route) => ({
    ...route,
    pattern: new URLPattern({ pathname: route.path }),
  }));

  return {
    async handle(request, config, logger) {
      const url = new URL(request.url);
      const matches = compiled.flatMap((route) => {
        const match = route.pattern.exec({ pathname: url.pathname });
        return match ? [{ route, params: match.pathname.groups }] : [];
      });

      if (matches.length === 0) return errorResponse("NOT_FOUND");

      const found = matches.find(({ route }) => route.method === request.method);
      if (!found) {
        const allow = [...new Set(matches.map(({ route }) => route.method))].join(", ");
        return errorResponse("METHOD_NOT_ALLOWED", { Allow: allow });
      }

      return found.route.handler({ request, url, params: found.params, config, logger });
    },
  };
}

/** Liveness only. It deliberately touches no backend, so it cannot be used to run up cost. */
export const healthHandler: Handler = ({ config }) =>
  jsonResponse({ status: "ok", environment: config.environment, time: new Date().toISOString() });
