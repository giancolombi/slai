/**
 * Citation and ambiguity paths point into an engine policy definition:
 *   calendar.timezone | calendar.weekly | calendar.holidays
 *   targets.<metric>.<priority> | pauseStatuses.<metric> | credits.<creditId>
 *   defaultPriority | warnAt
 */
import type { CreditRule, Metric, Priority, SlaPolicy } from "@slai/sla-engine";
import { METRIC_LABEL, PRIORITY_LABEL } from "../../lib/labels";

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export const WEEKDAY_LABEL: Record<Weekday, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};

export const METRICS: Metric[] = ["first_response", "next_response", "periodic_update", "resolution"];

/** Coerces an API `definition: unknown` into a complete, editable SlaPolicy. */
export function normalizeDefinition(input: unknown, fallbackName = "Untitled policy"): SlaPolicy {
  const d = (input ?? {}) as Partial<SlaPolicy>;
  return {
    id: d.id ?? "draft",
    name: d.name ?? fallbackName,
    calendar: {
      timezone: d.calendar?.timezone ?? "UTC",
      weekly: { ...(d.calendar?.weekly ?? {}) },
      holidays: [...(d.calendar?.holidays ?? [])],
    },
    targets: [...(d.targets ?? [])],
    defaultPriority: d.defaultPriority ?? null,
    pauseStatuses: { ...(d.pauseStatuses ?? {}) },
    botRepliesCount: d.botRepliesCount ?? false,
    warnAt: d.warnAt ? [...d.warnAt] : [0.5, 0.8],
    credits: [...(d.credits ?? [])],
  };
}

export function targetPath(metric: Metric, priority: Priority) {
  return `targets.${metric}.${priority}`;
}

/** The value a path points at (undefined when absent). Used to tell whether a value changed. */
export function valueAtPath(def: SlaPolicy, path: string): unknown {
  const [head, a, b] = path.split(".");
  switch (head) {
    case "calendar":
      if (a === "timezone") return def.calendar.timezone;
      if (a === "weekly") return def.calendar.weekly;
      if (a === "holidays") return def.calendar.holidays;
      return def.calendar;
    case "targets":
      return def.targets.find((t) => t.metric === a && t.priority === b);
    case "pauseStatuses":
      return def.pauseStatuses[a as Metric] ?? [];
    case "credits":
      return def.credits.find((c) => c.id === a);
    case "defaultPriority":
      return def.defaultPriority;
    case "warnAt":
      return def.warnAt;
    default:
      return undefined;
  }
}

/** Stable, key-order-insensitive comparison of two path values. */
export function sameValue(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function canonical(v: unknown): string {
  if (v === undefined) return "undefined";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const entries = Object.entries(v as Record<string, unknown>)
    .filter(([, x]) => x !== undefined)
    .sort(([x], [y]) => x.localeCompare(y));
  return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(",")}}`;
}

export function creditLabel(c: CreditRule | undefined): string {
  if (!c) return "Service credit";
  const scope = [c.metric ? METRIC_LABEL[c.metric] : null, c.priority ? PRIORITY_LABEL[c.priority] : null]
    .filter(Boolean)
    .join(" · ");
  return `${c.basis === "per_breach" ? "Per-breach credit" : "Attainment credit"}${scope ? ` · ${scope}` : ""}`;
}

export function pathLabel(path: string, def?: SlaPolicy): string {
  const [head, a, b] = path.split(".");
  switch (head) {
    case "calendar":
      return a === "timezone"
        ? "Time zone"
        : a === "weekly"
          ? "Business hours"
          : a === "holidays"
            ? "Holidays"
            : "Calendar";
    case "targets":
      return `${METRIC_LABEL[a as Metric] ?? a} · ${PRIORITY_LABEL[b as Priority] ?? b}`;
    case "pauseStatuses":
      return `Pauses · ${METRIC_LABEL[a as Metric] ?? a}`;
    case "credits":
      return creditLabel(def?.credits.find((c) => c.id === a));
    case "defaultPriority":
      return "Default priority";
    case "warnAt":
      return "Warning thresholds";
    default:
      return path;
  }
}

/** Every path that holds a value in this definition (for citation coverage). */
export function definedPaths(def: SlaPolicy): string[] {
  const paths = ["calendar.timezone", "calendar.weekly"];
  if (def.calendar.holidays.length) paths.push("calendar.holidays");
  for (const t of def.targets) paths.push(targetPath(t.metric, t.priority));
  for (const m of METRICS) if ((def.pauseStatuses[m] ?? []).length) paths.push(`pauseStatuses.${m}`);
  for (const c of def.credits) paths.push(`credits.${c.id}`);
  return paths;
}

/** Maps a zod issue path (["targets", 3, "minutes"]) onto a citation path. */
export function issueToPath(issuePath: readonly PropertyKey[], def: SlaPolicy): string {
  const [head, idx] = issuePath;
  if (head === "targets" && typeof idx === "number") {
    const t = def.targets[idx];
    if (t) return targetPath(t.metric, t.priority);
  }
  if (head === "credits" && typeof idx === "number") {
    const c = def.credits[idx];
    if (c) return `credits.${c.id}`;
  }
  if (head === "calendar") {
    const sub = issuePath[1];
    if (sub === "timezone" || sub === "holidays") return `calendar.${sub}`;
    return "calendar.weekly";
  }
  if (head === "pauseStatuses" && typeof idx === "string") return `pauseStatuses.${idx}`;
  return String(head ?? "definition");
}

export function fieldDomId(path: string) {
  return `field-${path.replace(/\./g, "-")}`;
}
export function citationDomId(path: string) {
  return `cite-${path.replace(/\./g, "-")}`;
}

/**
 * Maps a path emitted by contract extraction onto this screen's semantic path.
 * Extraction returns several policies, so its paths are index-based and
 * prefixed with the policy ("policies[0].targets[2].minutes"). Returns null
 * for paths that belong to a different policy of the same contract. Paths
 * already in semantic form pass through unchanged.
 */
export function extractionPath(path: string, policyIndex: number, extracted: SlaPolicy): string | null {
  let p = path;
  const scoped = /^policies\[(\d+)\]\.?(.*)$/.exec(p);
  if (scoped) {
    if (Number(scoped[1]) !== policyIndex) return null;
    p = scoped[2] ?? "";
  }
  const target = /^targets\[(\d+)\]/.exec(p);
  if (target) {
    const t = extracted.targets[Number(target[1])];
    return t ? targetPath(t.metric, t.priority) : null;
  }
  const credit = /^credits\[(\d+)\]/.exec(p);
  if (credit) {
    const c = extracted.credits[Number(credit[1])];
    return c ? `credits.${c.id}` : null;
  }
  if (p.startsWith("calendar.timezone")) return "calendar.timezone";
  if (p.startsWith("calendar.holidays")) return "calendar.holidays";
  if (p.startsWith("calendar")) return "calendar.weekly";
  const pause = /^pauseStatuses\.(\w+)/.exec(p);
  if (pause) return `pauseStatuses.${pause[1]}`;
  return p || null;
}
