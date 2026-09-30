import { z } from "zod";
import { validateCalendar } from "./calendar.js";
import { METRICS, PRIORITIES, type SlaPolicy, STATUSES } from "./types.js";

const localTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/, "expected HH:mm");
const range = z.object({ start: localTime, end: localTime });
const metric = z.enum(METRICS);
const priority = z.enum(PRIORITIES);
const status = z.enum(STATUSES);

export const calendarSchema = z.object({
  timezone: z.string().min(1),
  weekly: z.object({
    mon: z.array(range).optional(),
    tue: z.array(range).optional(),
    wed: z.array(range).optional(),
    thu: z.array(range).optional(),
    fri: z.array(range).optional(),
    sat: z.array(range).optional(),
    sun: z.array(range).optional(),
  }),
  holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).default([]),
});

export const targetSchema = z.object({
  metric,
  priority,
  minutes: z
    .number()
    .int()
    .positive()
    .max(60 * 24 * 365),
  clock: z.enum(["business", "calendar"]),
});

const creditAmount = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fixed_cents"), cents: z.number().int().nonnegative() }),
  z.object({ kind: z.literal("percent_of_fee"), percent: z.number().positive().max(100) }),
]);

export const creditRuleSchema = z.discriminatedUnion("basis", [
  z.object({
    id: z.string().min(1),
    basis: z.literal("per_breach"),
    metric: metric.nullable(),
    priority: priority.nullable(),
    amount: creditAmount,
    capPercent: z.number().positive().max(100).nullable(),
    sourceClause: z.string().nullable(),
  }),
  z.object({
    id: z.string().min(1),
    basis: z.literal("attainment"),
    metric: metric.nullable(),
    priority: priority.nullable(),
    tiers: z.array(z.object({ belowPercent: z.number().positive().max(100), amount: creditAmount })).min(1),
    capPercent: z.number().positive().max(100).nullable(),
    sourceClause: z.string().nullable(),
  }),
]);

export const policySchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    calendar: calendarSchema,
    targets: z.array(targetSchema).min(1),
    defaultPriority: priority.nullable(),
    pauseStatuses: z.partialRecord(metric, z.array(status)).default({}),
    botRepliesCount: z.boolean().default(false),
    warnAt: z.array(z.number().gt(0).lt(1)).max(2).default([0.5, 0.8]),
    credits: z.array(creditRuleSchema).default([]),
  })
  .superRefine((p, ctx) => {
    try {
      validateCalendar(p.calendar);
    } catch (e) {
      ctx.addIssue({ code: "custom", path: ["calendar"], message: (e as Error).message });
    }
    const seen = new Set<string>();
    for (const [i, t] of p.targets.entries()) {
      const key = `${t.metric}:${t.priority}`;
      if (seen.has(key)) {
        ctx.addIssue({ code: "custom", path: ["targets", i], message: `duplicate target ${key}` });
      }
      seen.add(key);
    }
    for (let i = 1; i < p.warnAt.length; i++) {
      if ((p.warnAt[i] ?? 0) <= (p.warnAt[i - 1] ?? 0)) {
        ctx.addIssue({ code: "custom", path: ["warnAt"], message: "warnAt must be ascending" });
      }
    }
    for (const status of ["solved", "closed"] as const) {
      for (const [m, list] of Object.entries(p.pauseStatuses)) {
        if (list?.includes(status)) {
          ctx.addIssue({
            code: "custom",
            path: ["pauseStatuses", m],
            message: `"${status}" stops clocks; it cannot be a pause status`,
          });
        }
      }
    }
  });

export type PolicyInput = z.input<typeof policySchema>;

/** Parses and validates untrusted policy input (API, LLM extraction). */
export function parsePolicy(input: unknown): SlaPolicy {
  return policySchema.parse(input) as SlaPolicy;
}
