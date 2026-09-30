/**
 * Realtime fan-out over Postgres LISTEN/NOTIFY. Producers (API, worker) call
 * `notifyEvent` inside their transaction, so listeners hear about a change only
 * once it has committed. Payloads carry ids only; the API filters by org.
 */
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Executor } from "./client.js";

export const EVENTS_CHANNEL = "slai_events";

/**
 * - `ticket.updated`: the ticket, its evaluation, or one of its agent runs changed (id = ticket id)
 * - `action.created` / `action.updated`: a proposed action appeared, or its status changed
 *   (approved, sending, sent, failed, rejected) (id = action id)
 * - `replay.progress`: a Breach Replay started, advanced or finished (id = replay id)
 * - `contract.updated`: a contract was uploaded or its extraction moved on (id = contract id)
 */
export const EVENT_TYPES = [
  "ticket.updated",
  "action.created",
  "action.updated",
  "replay.progress",
  "contract.updated",
] as const;
export const realtimeEventSchema = z.object({
  orgId: z.uuid(),
  type: z.enum(EVENT_TYPES),
  id: z.string().min(1).max(100),
});
export type RealtimeEvent = z.infer<typeof realtimeEventSchema>;

export async function notifyEvent(db: Executor, e: RealtimeEvent): Promise<void> {
  const payload = JSON.stringify(realtimeEventSchema.parse(e));
  await db.execute(sql`select pg_notify(${EVENTS_CHANNEL}, ${payload})`);
}

export function parseEvent(payload: string): RealtimeEvent | null {
  try {
    const r = realtimeEventSchema.safeParse(JSON.parse(payload));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}
