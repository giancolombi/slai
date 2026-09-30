import type { CreditAmount, CreditRule, Metric, Priority, TicketEvaluation } from "./types.js";

export interface Attainment {
  /** Cycles with a final outcome (achieved, or breached). */
  measured: number;
  met: number;
  breached: number;
  /** met / measured as a percentage; null when nothing was measured. */
  percent: number | null;
}

interface Filter {
  metric: Metric | null;
  priority: Priority | null;
}

function* outcomes(evals: TicketEvaluation[], f: Filter) {
  for (const ev of evals) {
    for (const m of ev.metrics) {
      if (f.metric && m.metric !== f.metric) continue;
      if (f.priority && m.priority !== f.priority) continue;
      for (const c of m.cycles) {
        if (c.state === "achieved" || c.state === "breached") yield c.state;
      }
    }
  }
}

/** Attainment over ticket evaluations for the period they were evaluated in. */
export function computeAttainment(evals: TicketEvaluation[], f: Filter = { metric: null, priority: null }): Attainment {
  let met = 0;
  let breached = 0;
  for (const o of outcomes(evals, f)) {
    if (o === "achieved") met++;
    else breached++;
  }
  const measured = met + breached;
  return { measured, met, breached, percent: measured === 0 ? null : (met / measured) * 100 };
}

function amountCents(a: CreditAmount, periodFeeCents: number): number {
  return a.kind === "fixed_cents" ? a.cents : Math.round((periodFeeCents * a.percent) / 100);
}

export interface CreditLine {
  ruleId: string;
  cents: number;
  /** Uncapped amount, for showing "cap saved you $X". */
  uncappedCents: number;
  breaches: number;
  attainment: Attainment | null;
  sourceClause: string | null;
}

/**
 * Service credits owed for one billing period, given the evaluations of every
 * ticket in that period and the customer's fee for the period.
 */
export function computeCredits(
  rules: CreditRule[],
  evals: TicketEvaluation[],
  periodFeeCents: number,
): { totalCents: number; lines: CreditLine[] } {
  const lines = rules.map((rule): CreditLine => {
    const att = computeAttainment(evals, rule);
    let uncapped = 0;
    if (rule.basis === "per_breach") {
      uncapped = att.breached * amountCents(rule.amount, periodFeeCents);
    } else if (att.percent !== null) {
      const hit = rule.tiers.filter((t) => att.percent! < t.belowPercent);
      // The harshest matching tier is the one with the lowest threshold.
      const tier = hit.sort((a, b) => a.belowPercent - b.belowPercent)[0];
      if (tier) uncapped = amountCents(tier.amount, periodFeeCents);
    }
    const cap =
      rule.capPercent === null ? Number.POSITIVE_INFINITY : Math.round((periodFeeCents * rule.capPercent) / 100);
    return {
      ruleId: rule.id,
      cents: Math.min(uncapped, cap),
      uncappedCents: uncapped,
      breaches: att.breached,
      attainment: rule.basis === "attainment" ? att : null,
      sourceClause: rule.sourceClause,
    };
  });
  return { totalCents: lines.reduce((s, l) => s + l.cents, 0), lines };
}
