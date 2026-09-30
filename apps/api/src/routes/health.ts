import { Hono } from "hono";
import type { AppDeps, AppEnv } from "../context.js";

export function healthRoutes(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  app.get("/healthz", (c) => c.json({ ok: true }));
  app.get("/readyz", async (c) => {
    let ok = false;
    try {
      ok = deps.ready ? await deps.ready() : true;
    } catch {
      ok = false;
    }
    return c.json({ ok }, ok ? 200 : 503);
  });
  return app;
}
