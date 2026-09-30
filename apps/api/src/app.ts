import { API_BASE } from "@slai/shared";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import type { AppDeps, AppEnv } from "./context.js";
import { ApiError } from "./errors.js";
import { requestLogger, safeErrorMessage } from "./logger.js";
import { loadSession, requireAuth, writesNeedMember } from "./middleware/auth.js";
import { csrf, noStore, requestContext } from "./middleware/security.js";
import { actionRoutes } from "./routes/actions.js";
import { auditRoutes } from "./routes/audit.js";
import { authRoutes } from "./routes/auth.js";
import { connectionRoutes, webhookRoutes } from "./routes/connections.js";
import { contractRoutes, MAX_UPLOAD_BYTES } from "./routes/contracts.js";
import { customerRoutes } from "./routes/customers.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { eventRoutes } from "./routes/events.js";
import { healthRoutes } from "./routes/health.js";
import { notificationRoutes } from "./routes/notifications.js";
import { orgRoutes } from "./routes/org.js";
import { policyRoutes } from "./routes/policies.js";
import { replayRoutes } from "./routes/replays.js";
import { ticketRoutes } from "./routes/tickets.js";

const JSON_LIMIT = 1024 * 1024;

export function createApp(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  const isWebhook = (path: string) => path.startsWith(`${API_BASE}/webhooks/`);

  app.use("*", requestContext({ trustProxy: deps.env.TRUST_PROXY }));
  app.use("*", requestLogger(deps.logger));
  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
      strictTransportSecurity: "max-age=63072000; includeSubDomains; preload",
      referrerPolicy: "no-referrer",
      crossOriginResourcePolicy: "same-site",
    }),
  );
  app.use(`${API_BASE}/*`, noStore);
  app.use(
    `${API_BASE}/*`,
    cors({
      origin: new URL(deps.env.APP_URL).origin,
      credentials: true,
      allowHeaders: ["Content-Type", "X-Requested-With", "X-Request-Id"],
      allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE"],
      exposeHeaders: ["X-Request-Id"],
      maxAge: 600,
    }),
  );
  app.use(`${API_BASE}/*`, csrf({ appUrl: deps.env.APP_URL, exempt: isWebhook }));
  app.use(`${API_BASE}/*`, async (c, next) => {
    const isUpload = c.req.method === "POST" && c.req.path === `${API_BASE}/contracts`;
    return bodyLimit({
      maxSize: isUpload ? MAX_UPLOAD_BYTES + 64 * 1024 : JSON_LIMIT,
      onError: () => {
        throw new ApiError(413, "payload_too_large", "Request body is too large.");
      },
    })(c, next);
  });

  app.route("/", healthRoutes(deps));
  app.route(API_BASE, healthRoutes(deps));
  app.route(`${API_BASE}/webhooks`, webhookRoutes(deps));

  app.use(`${API_BASE}/*`, loadSession(deps));
  app.route(`${API_BASE}/auth`, authRoutes(deps));

  // Everything below needs a fully signed-in session (MFA done where required).
  const authed = new Hono<AppEnv>();
  authed.use("*", requireAuth(), writesNeedMember);
  authed.route("/", orgRoutes(deps));
  authed.route("/", connectionRoutes(deps));
  authed.route("/customers", customerRoutes(deps));
  authed.route("/contracts", contractRoutes(deps));
  authed.route("/policies", policyRoutes(deps));
  authed.route("/tickets", ticketRoutes(deps));
  authed.route("/", actionRoutes(deps));
  authed.route("/notification-channels", notificationRoutes(deps));
  authed.route("/", dashboardRoutes(deps));
  authed.route("/replays", replayRoutes(deps));
  authed.route("/audit-events", auditRoutes(deps));
  authed.route("/events", eventRoutes(deps));
  app.route(API_BASE, authed);

  app.notFound((c) => c.json(new ApiError(404, "not_found", "Not found.").body(), 404));
  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json(err.body(), err.status);
    if (err instanceof HTTPException) {
      return c.json(
        new ApiError(err.status as never, "http_error", err.message || "Request failed.").body(),
        err.status,
      );
    }
    deps.logger.error(
      { requestId: c.get("requestId"), err: { name: (err as Error).name, message: safeErrorMessage(err) } },
      "unhandled error",
    );
    return c.json(new ApiError(500, "internal", `Something went wrong (request ${c.get("requestId")}).`).body(), 500);
  });
  return app;
}

export type App = ReturnType<typeof createApp>;
