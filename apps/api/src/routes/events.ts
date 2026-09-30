import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { type AppDeps, type AppEnv, auth } from "../context.js";

const HEARTBEAT_MS = 25_000;

/**
 * Server-Sent Events for the signed-in org: `ticket.updated`, `action.created`,
 * `replay.progress`, ... Payloads are ids only; the client refetches through
 * the API (and so through RLS). Events for other orgs are never forwarded.
 */
export function eventRoutes(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  app.get("/", (c) => {
    const { orgId } = auth(c);
    return streamSSE(c, async (stream) => {
      const queue: { type: string; id: string }[] = [];
      let wake: (() => void) | null = null;
      const unsubscribe = deps.events.subscribe(orgId, (e) => {
        queue.push({ type: e.type, id: e.id });
        wake?.();
      });
      stream.onAbort(() => {
        unsubscribe();
        wake?.();
      });
      await stream.writeSSE({ event: "ready", data: "{}" });
      while (!stream.aborted) {
        const e = queue.shift();
        if (e) {
          await stream.writeSSE({ event: e.type, data: JSON.stringify({ id: e.id }) });
          continue;
        }
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, HEARTBEAT_MS);
          wake = () => {
            clearTimeout(t);
            resolve();
          };
        });
        wake = null;
        if (!stream.aborted && queue.length === 0) await stream.write(": ping\n\n");
      }
      unsubscribe();
    });
  });

  return app;
}
