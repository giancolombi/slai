/**
 * The agents contract. Agents turn untrusted text (contracts, ticket threads)
 * into validated *proposals*. They never write to the database or the help
 * desk; the worker does that after validation and the autonomy decision.
 * See docs/adr/003-e2b-agent-sandboxes.md and docs/adr/004-model-api-keys.md.
 */
import type { AuthorRole, Metric, MetricResult, PolicyInput, Priority, RiskLevel } from "@slai/sla-engine";

export type AgentKind = "contract_extraction" | "triage" | "draft_reply";
export type Autonomy = "observe" | "assist" | "autopilot";
export type ModelProvider = "anthropic" | "openai" | "mock";

/** One model call's metered usage. Cost is in micro-dollars (1e-6 USD). */
export interface ModelUsage {
  provider: ModelProvider;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costMicros: number;
}

export interface RunMetering {
  usage: ModelUsage[];
  /** Null when the run was local (AGENT_RUNTIME=local). */
  sandbox: { id: string; templateBuild: string; seconds: number } | null;
  wallMs: number;
}

export type AgentRunResult<T> =
  | { ok: true; output: T; metering: RunMetering }
  | {
      ok: false;
      /** `bound_exceeded`: a token/time/tool-call limit was hit; never a partial success. */
      error: "invalid_output" | "bound_exceeded" | "provider_error" | "sandbox_error";
      message: string;
      metering: RunMetering;
    };

export interface RunBounds {
  maxWallMs: number;
  maxOutputTokens: number;
  maxModelCalls: number;
}

// ---------- contract extraction ----------

export interface ContractDocument {
  filename: string;
  mediaType:
    | "application/pdf"
    | "text/plain"
    | "text/markdown"
    | "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  /** Base64 file content. */
  base64: string;
}

export interface Citation {
  /** JSON path within the proposed policy, e.g. "targets[2].minutes". */
  path: string;
  /** Verbatim quote from the contract that supports the value. */
  quote: string;
  document: string;
  page: number | null;
}

export interface Ambiguity {
  path: string;
  question: string;
  /** What the extractor assumed; the reviewer must confirm or change it. */
  assumption: string;
  quote: string | null;
}

export interface ContractExtraction {
  /**
   * One policy per distinct SLA schedule in the contract (e.g. "Standard" and
   * "Premium" support tiers). Validated with the engine's policySchema.
   */
  policies: PolicyInput[];
  citations: Citation[];
  ambiguities: Ambiguity[];
  /** Named customer, fee, and term if the contract states them. */
  parties: { customerName: string | null; monthlyFeeCents: number | null; effectiveDate: string | null };
  /** Short plain-English summary for the review screen. */
  summary: string;
}

// ---------- ticket agents ----------

export interface ThreadMessage {
  at: string;
  authorRole: AuthorRole;
  authorName: string | null;
  public: boolean;
  body: string;
}

export interface TicketContext {
  ticketKey: string;
  subject: string;
  priority: Priority | null;
  status: string;
  customerName: string | null;
  /** Oldest first; bodies truncated to a bounded size by the worker. */
  thread: ThreadMessage[];
  sla: {
    risk: RiskLevel;
    mostUrgent: Pick<MetricResult, "metric" | "remainingMs" | "dueAt" | "state"> | null;
    metrics: Metric[];
  };
  /** Help-center snippets or saved replies the draft may rely on. */
  knowledge: { title: string; url: string | null; body: string }[];
  /** Agents/groups the triage may route to. */
  assignees: { sourceId: string; name: string; skills: string[] }[];
}

export interface TriageResult {
  summary: string;
  category: string;
  suggestedPriority: Priority;
  priorityReason: string;
  suggestedAssigneeSourceId: string | null;
  sentiment: "positive" | "neutral" | "frustrated" | "angry";
  /** Needs a human (legal, refund, security incident, outage, VIP escalation). */
  needsHuman: boolean;
  needsHumanReason: string | null;
  confidence: number;
}

export interface DraftReplyResult {
  /** Customer-facing reply, plain text with simple markdown. */
  body: string;
  /** Optional note for the human agent (what was checked, open questions). */
  internalNote: string | null;
  confidence: number;
  /** Knowledge items the reply relies on (indexes into TicketContext.knowledge). */
  usedKnowledge: number[];
  /**
   * Guardrail self-report. Autopilot refuses to send if any flag is set,
   * regardless of confidence.
   */
  flags: {
    promisesTimeline: boolean;
    mentionsPricingOrRefund: boolean;
    legalOrSecurity: boolean;
    unsureOfFacts: boolean;
  };
}

/** The runtime executes agents either in-process (dev) or in E2B sandboxes. */
export interface AgentRuntime {
  extractContract(docs: ContractDocument[], bounds?: Partial<RunBounds>): Promise<AgentRunResult<ContractExtraction>>;
  triage(ctx: TicketContext, bounds?: Partial<RunBounds>): Promise<AgentRunResult<TriageResult>>;
  draftReply(
    ctx: TicketContext,
    triage: TriageResult | null,
    bounds?: Partial<RunBounds>,
  ): Promise<AgentRunResult<DraftReplyResult>>;
}
