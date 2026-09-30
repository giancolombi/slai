import type { AgentRuntime, TicketContext } from "@slai/agents";
import type { ConnectorDefinition } from "@slai/connectors";
import type { Database, Keyring, OrgDatabase, StorageDriver } from "@slai/db";
import type { UsageReporter } from "./billing.js";
import type { Clock } from "./clock.js";
import { FIRST_SEEN_GRACE_MS, SEND_RECONCILE_AFTER_MS } from "./decide.js";
import type { Logger } from "./logger.js";
import type { Mailer } from "./notify.js";
import type { JobQueue } from "./queue.js";

export interface WorkerConfig {
  /** Max tickets one sweep claims. */
  sweepBatch: number;
  /** How long a claimed ticket stays leased before the sweep may claim it again. */
  leaseMs: number;
  syncIntervalMs: { demo: number; other: number };
  /** Incremental syncs re-read this much before the cursor (clock skew, late writes). */
  syncOverlapMs: number;
  /** A first or full sync reads tickets updated in the last N days. */
  backfillDays: number;
  appUrl: string;
  /** A ticket seen for the first time triggers only if its live breach is at most this old (TR-21f). */
  firstSeenGraceMs: number;
  /** A help-desk write claimed longer ago than this is reconciled (looked for, then retried) (TR-21g). */
  sendReconcileMs: number;
  /** A help-desk knowledge source is re-synced when its last sync is older than this (T-47). */
  knowledgeSyncIntervalMs: number;
  /** Stripe Billing Meter event names for overage (T-65). */
  meters?: { trackedTickets: string; credits: string };
  /** How often each org's billing snapshot is refreshed (T-65). */
  billingIntervalMs?: number;
}

export interface TicketResources extends Pick<TicketContext, "knowledge" | "assignees"> {
  /** The `knowledge_articles` id of each knowledge item, in the same order (T-47). */
  knowledgeIds?: (string | null)[];
}

/** Help-center snippets and assignees for the ticket agents (production: `knowledgeResources`, T-47). */
export type ResourceLoader = (
  orgId: string,
  ticket: { id: string; connectionId: string; subject: string; lastRequesterMessage?: string | null },
) => Promise<TicketResources>;

export interface WorkerDeps {
  /** slai_app (RLS): all org data through withOrg. */
  orgDb: OrgDatabase;
  /** slai_worker: the cross-org timer sweep and sync scheduling only. */
  systemDb: Database;
  queue: JobQueue;
  clock: Clock;
  keyring: Keyring;
  // biome-ignore lint/suspicious/noExplicitAny: each connector has its own credentials type
  connectors: { get(provider: string): ConnectorDefinition<any> | null };
  /** Injected into connectors and used for Slack webhooks. */
  fetch: typeof fetch;
  agents: AgentRuntime;
  mailer: Mailer;
  storage: StorageDriver;
  logger: Logger;
  resources: ResourceLoader;
  config: WorkerConfig;
  /** Stripe usage reporting; absent or null in manual billing mode (no Stripe keys) (T-65). */
  usageReporter?: UsageReporter | null;
}

export const noResources: ResourceLoader = async () => ({ knowledge: [], assignees: [] });

export const DEFAULT_CONFIG: WorkerConfig = {
  sweepBatch: 500,
  leaseMs: 120_000,
  syncIntervalMs: { demo: 60_000, other: 300_000 },
  syncOverlapMs: 120_000,
  backfillDays: 14,
  appUrl: "http://localhost:5173",
  firstSeenGraceMs: FIRST_SEEN_GRACE_MS,
  sendReconcileMs: SEND_RECONCILE_AFTER_MS,
  knowledgeSyncIntervalMs: 86_400_000,
};
