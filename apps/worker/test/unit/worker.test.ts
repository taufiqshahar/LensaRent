import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import type { AppConfig, Env } from "../../src/lib/env";
import { API_SECURITY_HEADERS, jsonResponse } from "../../src/lib/http";
import { createLogger } from "../../src/lib/logger";
import { createRouter } from "../../src/router";
import { EMULATOR_HOST, TEST_PROJECT_ID } from "../helpers";

const env: Env = {
  ENVIRONMENT: "test",
  FIREBASE_PROJECT_ID: TEST_PROJECT_ID,
  FIRESTORE_EMULATOR_HOST: EMULATOR_HOST,
};

function call(path: string, init?: RequestInit, bindings: Env = env): Promise<Response> {
  return worker.fetch(
    new Request(`https://lensarent.test${path}`, init) as Parameters<typeof worker.fetch>[0],
    bindings,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/health", () => {
  it("reports that the Worker is alive", async () => {
    const response = await call("/api/health");

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    const body = await response.json<{ status: string; environment: string; time: string }>();
    expect(body.status).toBe("ok");
    expect(body.environment).toBe("test");
    expect(Number.isNaN(Date.parse(body.time))).toBe(false);
  });

  it("sends the security headers and forbids caching", async () => {
    const response = await call("/api/health");
    for (const [name, value] of Object.entries(API_SECURITY_HEADERS)) {
      expect(response.headers.get(name)).toBe(value);
    }
    expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("unknown requests", () => {
  it("answers an unknown API path with a generic 404", async () => {
    const response = await call("/api/does-not-exist");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "NOT_FOUND", message: "Halaman atau sumber tidak dijumpai." },
    });
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("answers a wrong method with 405 and the allowed methods", async () => {
    const response = await call("/api/health", { method: "POST" });
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET");
    expect(await response.json()).toEqual({
      error: { code: "METHOD_NOT_ALLOWED", message: "Kaedah permintaan tidak dibenarkan." },
    });
  });

  it("hands non-API paths to static assets when the binding exists", async () => {
    const assets = { fetch: vi.fn(() => Promise.resolve(new Response("<html></html>"))) };
    const response = await call("/tempah", undefined, {
      ...env,
      ASSETS: assets as unknown as Fetcher,
    });
    expect(await response.text()).toBe("<html></html>");
    expect(assets.fetch).toHaveBeenCalledOnce();
  });

  it("answers non-API paths with 404 when there is no assets binding", async () => {
    expect((await call("/tempah")).status).toBe(404);
  });
});

describe("failures", () => {
  it("returns a generic 500 and logs the detail when the Worker is misconfigured", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await call("/api/health", undefined, {
      ENVIRONMENT: "production",
      FIREBASE_PROJECT_ID: "lensarent-production",
    });

    expect(response.status).toBe(500);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      error: { code: "INTERNAL_ERROR", message: "Ralat dalaman. Sila cuba sebentar lagi." },
    });
    expect(text).not.toContain("FIREBASE");
    expect(text).not.toContain("stack");

    expect(logged).toHaveBeenCalledOnce();
    expect(JSON.parse(logged.mock.calls[0]![0] as string)).toMatchObject({
      event: "request.failed",
      level: "error",
      method: "GET",
      path: "/api/health",
      error: { name: "ConfigError" },
    });
  });
});

describe("createRouter", () => {
  const config: AppConfig = {
    environment: "test",
    firebaseProjectId: TEST_PROJECT_ID,
    serviceAccountJson: undefined,
    firestoreEmulatorHost: EMULATOR_HOST,
  };
  const logger = createLogger({ environment: "test", sink: () => undefined });
  const router = createRouter([
    {
      method: "GET",
      path: "/api/things/:id",
      handler: ({ params, url }) => jsonResponse({ id: params.id, q: url.searchParams.get("q") }),
    },
    { method: "PUT", path: "/api/things/:id", handler: () => jsonResponse({ updated: true }) },
    {
      method: "POST",
      path: "/api/boom",
      handler: () => {
        throw new Error("boom");
      },
    },
  ]);

  it("passes path parameters and the URL to the handler", async () => {
    const response = await router.handle(
      new Request("https://lensarent.test/api/things/abc123?q=x"),
      config,
      logger,
    );
    expect(await response.json()).toEqual({ id: "abc123", q: "x" });
  });

  it("lists every method a path supports", async () => {
    const response = await router.handle(
      new Request("https://lensarent.test/api/things/abc123", { method: "DELETE" }),
      config,
      logger,
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET, PUT");
  });

  it("lets handler errors reach the Worker's error boundary", async () => {
    await expect(
      router.handle(
        new Request("https://lensarent.test/api/boom", { method: "POST" }),
        config,
        logger,
      ),
    ).rejects.toThrow("boom");
  });
});
