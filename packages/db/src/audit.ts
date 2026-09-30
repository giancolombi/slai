import type { Executor } from "./client.js";
import { auditEvents } from "./schema.js";

export interface AuditEntry {
  /** Null only for events before an org is known (e.g. a failed login); write those via systemDb. */
  orgId: string | null;
  actor: { type: "user" | "system" | "agent"; id: string | null; name?: string | null };
  /** Dotted verb, e.g. "auth.login", "policy.approved", "action.sent". */
  action: string;
  target: { type: string; id: string | null };
  metadata?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

/**
 * Appends one audit event. Call it inside the same transaction as the change it
 * records (withOrg's tx), so the change and its audit record commit together.
 * Never put secrets in metadata.
 */
export async function audit(db: Executor, e: AuditEntry): Promise<void> {
  await db.insert(auditEvents).values({
    orgId: e.orgId,
    actorType: e.actor.type,
    actorId: e.actor.id,
    actorName: e.actor.name ?? null,
    action: e.action,
    targetType: e.target.type,
    targetId: e.target.id,
    metadata: e.metadata ?? {},
    ip: e.ip ?? null,
    userAgent: e.userAgent ?? null,
    requestId: e.requestId ?? null,
  });
}
