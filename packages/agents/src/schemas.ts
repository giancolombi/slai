/**
 * Zod schemas for everything a model returns. They are model-facing: every
 * field is required (nullable instead of optional) so they convert to strict
 * JSON schemas for constrained decoding. Domain rules for policies are
 * enforced afterwards by the engine's `parsePolicy`.
 */
import { METRICS, type PolicyInput, PRIORITIES, policySchema, STATUSES } from "@slai/sla-engine";
import { z } from "zod";

const metric = z.enum(METRICS);
const priority = z.enum(PRIORITIES);
const status = z.enum(STATUSES);
const confidence = z.number().min(0).max(1);

// ---------- triage ----------

export const triageResultSchema = z.object({
  summary: z.string().min(1).max(600),
  category: z.string().min(1).max(60),
  suggestedPriority: priority,
  priorityReason: z.string().max(400),
  suggestedAssigneeSourceId: z.string().nullable(),
  sentiment: z.enum(["positive", "neutral", "frustrated", "angry"]),
  needsHuman: z.boolean(),
  needsHumanReason: z.string().nullable(),
  confidence,
});

// ---------- draft ----------

export const draftReplyResultSchema = z.object({
  body: z.string().max(8000),
  internalNote: z.string().max(2000).nullable(),
  confidence,
  usedKnowledge: z.array(z.number().int().nonnegative()),
  flags: z.object({
    promisesTimeline: z.boolean(),
    mentionsPricingOrRefund: z.boolean(),
    legalOrSecurity: z.boolean(),
    unsureOfFacts: z.boolean(),
  }),
});

// ---------- contract extraction ----------

const range = z.object({ start: z.string(), end: z.string() });
const creditAmount = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fixed_cents"), cents: z.number().int() }),
  z.object({ kind: z.literal("percent_of_fee"), percent: z.number() }),
]);

export const policyDraftSchema = z.object({
  id: z.string(),
  name: z.string(),
  calendar: z.object({
    timezone: z.string(),
    weekly: z.object({
      mon: z.array(range),
      tue: z.array(range),
      wed: z.array(range),
      thu: z.array(range),
      fri: z.array(range),
      sat: z.array(range),
      sun: z.array(range),
    }),
    holidays: z.array(z.string()),
  }),
  targets: z.array(z.object({ metric, priority, minutes: z.number(), clock: z.enum(["business", "calendar"]) })),
  defaultPriority: priority.nullable(),
  pauseStatuses: z.array(z.object({ metric, statuses: z.array(status) })),
  botRepliesCount: z.boolean(),
  credits: z.array(
    z.discriminatedUnion("basis", [
      z.object({
        id: z.string(),
        basis: z.literal("per_breach"),
        metric: metric.nullable(),
        priority: priority.nullable(),
        amount: creditAmount,
        capPercent: z.number().nullable(),
        sourceClause: z.string().nullable(),
      }),
      z.object({
        id: z.string(),
        basis: z.literal("attainment"),
        metric: metric.nullable(),
        priority: priority.nullable(),
        tiers: z.array(z.object({ belowPercent: z.number(), amount: creditAmount })),
        capPercent: z.number().nullable(),
        sourceClause: z.string().nullable(),
      }),
    ]),
  ),
});
export type PolicyDraft = z.infer<typeof policyDraftSchema>;

export const citationSchema = z.object({
  path: z.string(),
  quote: z.string(),
  document: z.string(),
  page: z.number().int().nullable(),
});

export const ambiguitySchema = z.object({
  path: z.string(),
  question: z.string(),
  assumption: z.string(),
  quote: z.string().nullable(),
});

export const extractionDraftSchema = z.object({
  policies: z.array(policyDraftSchema),
  citations: z.array(citationSchema),
  ambiguities: z.array(ambiguitySchema),
  parties: z.object({
    customerName: z.string().nullable(),
    monthlyFeeCents: z.number().int().nullable(),
    effectiveDate: z.string().nullable(),
  }),
  summary: z.string(),
});
export type ExtractionDraft = z.infer<typeof extractionDraftSchema>;

/** Model draft -> engine PolicyInput (empty days dropped, pause list -> record). */
export function toPolicyInput(d: PolicyDraft): PolicyInput {
  const weekly: Record<string, { start: string; end: string }[]> = {};
  for (const [day, ranges] of Object.entries(d.calendar.weekly)) if (ranges.length) weekly[day] = ranges;
  const pauseStatuses: Record<string, string[]> = {};
  for (const p of d.pauseStatuses) pauseStatuses[p.metric] = [...(pauseStatuses[p.metric] ?? []), ...p.statuses];
  return {
    id: d.id,
    name: d.name,
    calendar: { timezone: d.calendar.timezone, weekly, holidays: d.calendar.holidays },
    targets: d.targets,
    defaultPriority: d.defaultPriority,
    pauseStatuses,
    botRepliesCount: d.botRepliesCount,
    credits: d.credits,
  } as PolicyInput;
}

// ---------- worker-side validation of a full extraction (e.g. from a sandbox) ----------

export const contractExtractionSchema = z.object({
  policies: z.array(policySchema),
  citations: z.array(citationSchema),
  ambiguities: z.array(ambiguitySchema),
  parties: extractionDraftSchema.shape.parties,
  summary: z.string(),
});
