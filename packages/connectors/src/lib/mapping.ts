/**
 * Raw status/priority → canonical values through the connection's
 * `FieldMapping`. Lookups are exact first, then case-insensitive.
 *
 * Unknown raw statuses map to `open` (the clock keeps running, which is the
 * conservative choice for an SLA monitor: we never silently pause a clock) and
 * are flagged so the UI can ask the customer to map them. Unknown priorities
 * map to null (the policy's defaultPriority applies) and are flagged too.
 */
import type { Priority, TicketStatus } from "@slai/sla-engine";
import type { FieldMapping, MappingIssue } from "../types.js";

export const UNKNOWN_STATUS_DEFAULT: TicketStatus = "open";

function lookup<V>(table: Record<string, V>, raw: string): { hit: true; value: V } | { hit: false } {
  if (Object.hasOwn(table, raw)) return { hit: true, value: table[raw] as V };
  const lower = raw.toLowerCase();
  for (const [k, v] of Object.entries(table)) {
    if (k.toLowerCase() === lower) return { hit: true, value: v };
  }
  return { hit: false };
}

export interface Mapped<V> {
  value: V;
  known: boolean;
}

export function mapStatus(mapping: FieldMapping, raw: string): Mapped<TicketStatus> {
  const r = lookup(mapping.status, raw);
  return r.hit ? { value: r.value, known: true } : { value: UNKNOWN_STATUS_DEFAULT, known: false };
}

/** A null/empty raw priority is a known "no priority", not an unmapped value. */
export function mapPriority(mapping: FieldMapping, raw: string | null | undefined): Mapped<Priority | null> {
  if (raw === null || raw === undefined || raw === "") return { value: null, known: true };
  const r = lookup(mapping.priority, raw);
  return r.hit ? { value: r.value, known: true } : { value: null, known: false };
}

/** Reverse lookup for write-back: the first raw value that maps to `p`. */
export function rawPriorityFor(mapping: FieldMapping, p: Priority): string | null {
  for (const [raw, v] of Object.entries(mapping.priority)) if (v === p) return raw;
  return null;
}

/** Collects mapping issues for a ticket snapshot. */
export function mappingIssues(
  mapping: FieldMapping,
  rawStatus: string,
  rawPriority: string | null,
): { status: TicketStatus; priority: Priority | null; issues: MappingIssue[] } {
  const s = mapStatus(mapping, rawStatus);
  const p = mapPriority(mapping, rawPriority);
  const issues: MappingIssue[] = [];
  if (!s.known) issues.push({ field: "status", raw: rawStatus });
  if (!p.known && rawPriority !== null) issues.push({ field: "priority", raw: rawPriority });
  return { status: s.value, priority: p.value, issues };
}
