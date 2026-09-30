/**
 * The connector contract. Every help desk adapter implements `ConnectorDefinition`
 * and maps its platform's data into canonical tickets and events (see
 * docs/research/CONNECTORS.md §4). The SLA engine consumes only canonical events.
 *
 * Connectors are pure HTTP adapters: they receive an injected `fetch`, perform
 * no persistence, and never read environment variables. The worker owns
 * credentials (decrypting them just-in-time), storage, retries and scheduling.
 */
import type { AuthorRole, Priority, TicketStatus } from "@slai/sla-engine";
import type { z } from "zod";

export const PROVIDERS = [
  "zendesk",
  "jira_service_management",
  "intercom",
  "freshdesk",
  "hubspot",
  "zammad",
  "salesforce",
  "servicenow",
  "zoho_desk",
  "front",
  "gorgias",
  "help_scout",
  "linear",
  "github",
  "demo",
] as const;
export type ProviderId = (typeof PROVIDERS)[number];

export type AuthKind = "api_token" | "oauth2" | "basic";

export interface ExternalRef {
  sourceId: string;
  /** Human-facing key, e.g. "#12345" or "SUP-42". */
  displayKey: string;
  url: string | null;
}

export interface CanonicalComment {
  sourceId: string;
  at: Date;
  authorRole: AuthorRole;
  authorName: string | null;
  authorSourceId: string | null;
  public: boolean;
  bodyText: string;
}

/** Canonical ticket event: the engine's TicketEvent plus provenance. */
export type CanonicalEvent = (
  | { type: "created"; priority: Priority | null; status: TicketStatus }
  | { type: "priority_changed"; priority: Priority | null; rawPriority: string | null }
  | { type: "status_changed"; status: TicketStatus; rawStatus: string }
  | { type: "comment"; author: AuthorRole; public: boolean; commentSourceId: string }
  | { type: "assignee_changed"; assigneeSourceId: string | null }
  | { type: "tags_changed"; tags: string[] }
) & {
  /** Source timestamp. The SLA clock uses this, never the time we received it. */
  at: Date;
  /**
   * Stable, source-derived dedupe key: the same event arriving by webhook and
   * by poll must produce the same key. e.g. "zendesk:audit:123:2".
   */
  idempotencyKey: string;
};

export interface CanonicalTicket {
  ref: ExternalRef;
  subject: string;
  status: TicketStatus;
  rawStatus: string;
  priority: Priority | null;
  rawPriority: string | null;
  requester: {
    sourceId: string | null;
    email: string | null;
    name: string | null;
    orgSourceId: string | null;
    orgName: string | null;
  };
  assignee: { sourceId: string; name: string | null } | null;
  groupSourceId: string | null;
  tags: string[];
  channel: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** A ticket with its full history, as needed for SLA evaluation and agents. */
export interface TicketWithHistory {
  ticket: CanonicalTicket;
  events: CanonicalEvent[];
  comments: CanonicalComment[];
}

/**
 * Per-connection overrides of how raw statuses and priorities map to canonical
 * values. Connectors ship defaults; customers can override in the UI.
 */
export interface FieldMapping {
  status: Record<string, TicketStatus>;
  priority: Record<string, Priority | null>;
}

export interface ConnectorContext<Credentials> {
  credentials: Credentials;
  /** Connection-level config, e.g. subdomain, instance URL, pipeline id. */
  config: Record<string, unknown>;
  mapping: FieldMapping;
  fetch: typeof fetch;
  /** Used to cap retries/backoff; connectors must honor Retry-After. */
  signal?: AbortSignal;
}

export type WebhookResult =
  | { ok: true; ticketSourceIds: string[] }
  | { ok: false; reason: "bad_signature" | "unsupported" | "malformed" };

export interface WebhookRequest {
  headers: Record<string, string | undefined>;
  /** Raw body exactly as received — signature checks need the original bytes. */
  rawBody: string;
  /** Absolute URL the webhook was delivered to (some providers sign it). */
  url: string;
}

export interface Page<T> {
  items: T[];
  /** Opaque cursor for the next page; null when exhausted. */
  nextCursor: string | null;
}

export interface WriteCapabilities {
  internalNote: boolean;
  publicReply: boolean;
  assign: boolean;
  priority: boolean;
  tags: boolean;
}

export class ConnectorError extends Error {
  constructor(
    message: string,
    readonly kind: "auth" | "rate_limited" | "not_found" | "invalid" | "upstream" | "unsupported",
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
  }
}

export interface ConnectorClient {
  /** Validates credentials; returns the account's display name. */
  testConnection(): Promise<{ accountName: string; accountId: string }>;
  /** Tickets updated at or after `since`, paginated. Used for sync and replay. */
  listUpdatedTickets(since: Date, cursor: string | null): Promise<Page<CanonicalTicket>>;
  /** One ticket with full status/priority/comment history. */
  getTicketWithHistory(sourceId: string): Promise<TicketWithHistory>;
  /** Verifies and parses a webhook delivery. Must reject bad signatures. */
  handleWebhook(req: WebhookRequest, webhookSecret: string | null): Promise<WebhookResult>;
  postInternalNote(sourceId: string, body: string): Promise<{ commentSourceId: string | null }>;
  postPublicReply(sourceId: string, body: string): Promise<{ commentSourceId: string | null }>;
  updateTicket(
    sourceId: string,
    patch: { priority?: Priority; assigneeSourceId?: string; addTags?: string[] },
  ): Promise<void>;
}

export interface ConnectorDefinition<Credentials = unknown> {
  provider: ProviderId;
  displayName: string;
  authKind: AuthKind;
  /** Validates what the user enters in the connect form. */
  credentialsSchema: z.ZodType<Credentials>;
  /** Fields the connect form should render (derived for UI; secrets masked). */
  credentialFields: { key: string; label: string; secret: boolean; placeholder?: string; help?: string }[];
  supportsWebhooks: boolean;
  write: WriteCapabilities;
  defaultMapping: FieldMapping;
  docsUrl: string;
  create(ctx: ConnectorContext<Credentials>): ConnectorClient;
}
