import type { AgentRuntime, TicketContext } from "@slai/agents";
import type { ConnectorDefinition } from "@slai/connectors";
import type { Database, Keyring, OrgDatabase, StorageDriver } from "@slai/db";
import type { Clock } from "./clock.js";
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
}

/** Help-center snippets and assignees for the ticket agents. No knowledge base exists yet, so the default is none. */
export type ResourceLoader = (
  orgId: string,
  ticket: { id: string; connectionId: string; subject: string },
) => Promise<Pick<TicketContext, "knowledge" | "assignees">>;

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
}

export const noResources: ResourceLoader = async () => ({ knowledge: [], assignees: [] });

export const DEFAULT_CONFIG: WorkerConfig = {
  sweepBatch: 500,
  leaseMs: 120_000,
  syncIntervalMs: { demo: 60_000, other: 300_000 },
  syncOverlapMs: 120_000,
  backfillDays: 14,
  appUrl: "http://localhost:5173",
};
