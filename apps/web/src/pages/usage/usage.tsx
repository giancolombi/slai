import type { OrgSettings, UsageSummary } from "@slai/shared";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Checkbox,
  cn,
  Dialog,
  EmptyState,
  Field,
  formatDuration,
  formatMoney,
  formatNumber,
  Input,
  Skeleton,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  toast,
} from "@slai/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Gauge, Pencil, Receipt, Sparkles } from "lucide-react";
import { type FormEvent, useState } from "react";
import { ErrorState, Page } from "../../components/page";
import { api, errorMessage } from "../../lib/api";
import { PLANS } from "../../lib/labels";
import { qk, useMe, useOrg, useUsage } from "../../lib/queries";
import { UsageMeter } from "./meter";

const KIND_META: Record<string, { label: string; help: string; unit?: "seconds" }> = {
  triage: { label: "Ticket triage", help: "Category, priority and summary per ticket" },
  draft_reply: { label: "Reply drafts", help: "Drafts queued for one-click approval" },
  autopilot_reply: { label: "Autopilot replies", help: "Replies sent within guardrails" },
  contract_extraction: { label: "Contract extraction", help: "Policies extracted from uploaded contracts" },
  policy_preview: { label: "Policy previews", help: "Replays of a draft policy before approval" },
  sandbox_seconds: { label: "Sandbox time", help: "Seconds of isolated agent compute", unit: "seconds" },
};

function kindMeta(kind: string) {
  return KIND_META[kind] ?? { label: kind.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()), help: "" };
}

/** Billing periods are UTC calendar months; show them as such in every time zone. */
const utcDate = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
function periodDate(d: string | Date) {
  return utcDate.format(new Date(d));
}

function planFor(id: string) {
  return PLANS.find((p) => p.id === id) ?? PLANS[2];
}

function SpendCapDialog({
  open,
  onOpenChange,
  org,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  org: OrgSettings;
}) {
  const queryClient = useQueryClient();
  const [noCap, setNoCap] = useState(org.monthlySpendCapCents === null);
  const [dollars, setDollars] = useState(
    org.monthlySpendCapCents !== null ? String(org.monthlySpendCapCents / 100) : "",
  );
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (cents: number | null) => api.org.update({ monthlySpendCapCents: cents }),
    onSuccess: (next) => {
      queryClient.setQueryData(qk.org, next);
      void queryClient.invalidateQueries({ queryKey: qk.usage });
      toast({
        tone: "success",
        title: "Spend cap updated",
        description:
          next.monthlySpendCapCents === null
            ? "No monthly cap."
            : `Capped at ${formatMoney(next.monthlySpendCapCents)} a month.`,
      });
      onOpenChange(false);
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (noCap) return save.mutate(null);
    const value = Number(dollars);
    if (!dollars.trim() || !Number.isFinite(value) || value < 0) return setError("Enter an amount of 0 or more.");
    setError(null);
    save.mutate(Math.round(value * 100));
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Monthly spend cap"
      description="Caps AI credits (triage, drafts, autopilot). At the cap, autonomy steps down to keep you within budget."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="spend-cap-form" loading={save.isPending}>
            Save cap
          </Button>
        </>
      }
    >
      <form id="spend-cap-form" onSubmit={submit} noValidate className="flex flex-col gap-4">
        <Field label="Cap per month (USD)" error={error ?? undefined} hint="Default: included credits + 50%.">
          <Input
            type="number"
            min={0}
            step={50}
            inputMode="decimal"
            leading={<span className="text-sm">$</span>}
            value={dollars}
            disabled={noCap}
            onChange={(e) => setDollars(e.target.value)}
          />
        </Field>
        <Field label="No cap" hint="Autonomy never steps down for budget reasons." inline>
          <Checkbox checked={noCap} onCheckedChange={(v) => setNoCap(v === true)} />
        </Field>
      </form>
    </Dialog>
  );
}

function UsageSkeleton() {
  return (
    <div className="flex flex-col gap-5" role="status" aria-live="polite">
      <span className="sr-only">Loading usage…</span>
      <div className="grid gap-4 md:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-40 rounded-lg" />
        ))}
      </div>
      <Skeleton className="h-72 rounded-lg" />
    </div>
  );
}

function Overview({
  usage,
  org,
  canEdit,
  onEditCap,
}: {
  usage: UsageSummary;
  org: OrgSettings;
  canEdit: boolean;
  onEditCap: () => void;
}) {
  const plan = planFor(org.plan);
  const cap = usage.spendCapCents;
  const capFraction = cap ? usage.costCents / cap : 0;
  const atCap = cap !== null && capFraction >= 1;
  const actions = usage.byKind.filter((k) => k.kind !== "sandbox_seconds").reduce((s, k) => s + k.count, 0);
  return (
    <div className="grid gap-4 md:grid-cols-3">
      <Card className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-medium text-ink-muted">Plan</p>
            <p className="mt-1 text-xl font-semibold tracking-tight text-ink">{plan.name}</p>
          </div>
          <Badge tone="accent">{plan.priceCents ? `${formatMoney(plan.priceCents)}/mo` : "Free"}</Badge>
        </div>
        <p className="mt-1 text-sm text-ink-muted">{plan.blurb}</p>
        <div className="mt-5 flex items-baseline justify-between text-xs">
          <span className="text-ink-muted">SLA-tracked tickets</span>
          <span className="font-mono text-ink tnum">
            {formatNumber(usage.trackedTickets)}
            <span className="text-ink-subtle"> / {plan.tickets ? formatNumber(plan.tickets) : "—"}</span>
          </span>
        </div>
        <UsageMeter
          className="mt-2"
          label="SLA-tracked tickets this period"
          value={usage.trackedTickets}
          max={plan.tickets || null}
          valueText={`${formatNumber(usage.trackedTickets)} of ${formatNumber(plan.tickets)} tickets`}
        />
      </Card>

      <Card className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-medium text-ink-muted">AI spend this period</p>
            <p className="mt-1 font-mono text-2xl font-medium tracking-tight text-ink tnum">
              {formatMoney(usage.costCents, "exact")}
            </p>
          </div>
          {canEdit && (
            <Button size="sm" variant="ghost" leadingIcon={<Pencil />} onClick={onEditCap}>
              Edit cap
            </Button>
          )}
        </div>
        <div className="mt-5 flex items-baseline justify-between text-xs">
          <span className="text-ink-muted">Spend cap</span>
          <span className="font-mono text-ink tnum">{cap === null ? "No cap" : formatMoney(cap)}</span>
        </div>
        <UsageMeter
          className="mt-2"
          label="AI spend against the monthly cap"
          value={usage.costCents}
          max={cap}
          valueText={
            cap === null
              ? `${formatMoney(usage.costCents)}, no cap`
              : `${formatMoney(usage.costCents)} of ${formatMoney(cap)}`
          }
        />
        <p className={cn("mt-3 text-xs", atCap ? "font-medium text-breached-text" : "text-ink-muted")}>
          {cap === null
            ? "No cap set. Autonomy never steps down for budget."
            : atCap
              ? "Cap reached: autopilot has stepped down to assist, then observe."
              : `${Math.round(capFraction * 100)}% of cap used.`}
        </p>
      </Card>

      <Card className="p-5">
        <p className="text-xs font-medium text-ink-muted">Credits used</p>
        <p className="mt-1 font-mono text-2xl font-medium tracking-tight text-ink tnum">
          {formatNumber(usage.creditsUsed)}
        </p>
        <p className="mt-1 text-sm text-ink-muted">
          across <span className="font-mono text-ink tnum">{formatNumber(actions)}</span> agent actions
        </p>
        <div className="mt-5 flex gap-2.5 rounded-md border border-line bg-sunken/60 p-3 text-xs leading-relaxed text-ink-muted">
          <Gauge className="mt-0.5 size-4 shrink-0 text-accent-text" aria-hidden />
          <p>
            At the cap, autonomy degrades autopilot → assist → observe.{" "}
            <span className="font-medium text-ink">The SLA clock and alerts are never throttled.</span>
          </p>
        </div>
      </Card>
    </div>
  );
}

function ByKind({ usage }: { usage: UsageSummary }) {
  const total = usage.byKind.reduce((s, k) => s + k.costCents, 0) || 1;
  const rows = [...usage.byKind].sort((a, b) => b.costCents - a.costCents);
  return (
    <Card>
      <CardHeader title="Usage by kind" description="Every model call and sandbox second is metered." />
      {rows.length === 0 ? (
        <EmptyState
          compact
          icon={<Receipt />}
          title="No usage yet this period"
          description="Agent runs, contract extraction and previews will appear here."
        />
      ) : (
        <Table aria-label="Usage by kind">
          <THead>
            <tr>
              <TH>Kind</TH>
              <TH align="right">Count</TH>
              <TH align="right">Cost</TH>
              <TH className="w-[32%]">Share of spend</TH>
            </tr>
          </THead>
          <TBody>
            {rows.map((k) => {
              const meta = kindMeta(k.kind);
              const share = k.costCents / total;
              return (
                <TR key={k.kind}>
                  <TD>
                    <div className="font-medium text-ink">{meta.label}</div>
                    {meta.help && <div className="text-xs text-ink-muted">{meta.help}</div>}
                  </TD>
                  <TD numeric>{meta.unit === "seconds" ? formatDuration(k.count * 1000) : formatNumber(k.count)}</TD>
                  <TD numeric>{formatMoney(k.costCents, "exact")}</TD>
                  <TD>
                    <div className="flex items-center gap-3">
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-sunken" aria-hidden>
                        <div
                          className="h-full rounded-full bg-accent"
                          style={{ width: `${Math.max(share * 100, 1)}%` }}
                        />
                      </div>
                      <span className="w-10 text-right font-mono text-xs text-ink-muted tnum">
                        {Math.round(share * 100)}%
                      </span>
                    </div>
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      )}
    </Card>
  );
}

function PlanComparison({ current }: { current: string }) {
  const plans = PLANS.filter((p) => p.id !== "replay");
  return (
    <section aria-labelledby="plans-heading">
      <div className="mb-3 flex items-end justify-between gap-4">
        <div>
          <h2 id="plans-heading" className="text-md font-semibold text-ink">
            Plans
          </h2>
          <p className="text-sm text-ink-muted">
            Priced by SLA-tracked tickets plus prepaid AI credits. No per-seat pricing.
          </p>
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        {plans.map((p) => {
          const isCurrent = p.id === current;
          return (
            <Card
              key={p.id}
              className={cn("flex flex-col p-5", isCurrent && "border-accent shadow-sm ring-1 ring-accent/30")}
            >
              <div className="flex items-center justify-between">
                <p className="font-semibold text-ink">{p.name}</p>
                {isCurrent && (
                  <Badge tone="accent" size="sm" icon={<Check />}>
                    Current
                  </Badge>
                )}
              </div>
              <p className="mt-3 font-mono text-2xl font-medium tracking-tight text-ink tnum">
                {formatMoney(p.priceCents)}
                <span className="font-sans text-sm font-normal text-ink-muted"> / month</span>
              </p>
              <ul className="mt-4 flex flex-1 flex-col gap-1.5 text-sm text-ink-muted">
                <li className="flex gap-2">
                  <Check className="mt-0.5 size-4 shrink-0 text-ok-text" aria-hidden />
                  {formatNumber(p.tickets)} tracked tickets
                </li>
                <li className="flex gap-2">
                  <Check className="mt-0.5 size-4 shrink-0 text-ok-text" aria-hidden />
                  {p.blurb}
                </li>
              </ul>
              <Button
                className="mt-5"
                variant={isCurrent ? "secondary" : "primary"}
                disabled={isCurrent}
                asChild={!isCurrent}
              >
                {isCurrent ? "Your plan" : <a href="mailto:sales@slai.example?subject=Plan%20change">Talk to sales</a>}
              </Button>
            </Card>
          );
        })}
      </div>
      <p className="mt-3 flex items-center gap-1.5 text-xs text-ink-muted">
        <Sparkles className="size-3.5" aria-hidden />
        Enterprise: committed credits, SSO and an optional breach-prevention guarantee.
      </p>
    </section>
  );
}

export function UsagePage() {
  const usage = useUsage();
  const org = useOrg();
  const { data: me } = useMe();
  const [capOpen, setCapOpen] = useState(false);
  const canEdit = me?.role === "owner" || me?.role === "admin";
  const period = usage.data
    ? `${periodDate(usage.data.period.start)} – ${periodDate(new Date(new Date(usage.data.period.end).getTime() - 1))}`
    : undefined;

  const error = usage.error ?? org.error;
  return (
    <Page title="Usage & billing" description={period ? `Current period: ${period}` : "Credits, spend and plan."}>
      {usage.isPending || org.isPending ? (
        <UsageSkeleton />
      ) : error || !usage.data || !org.data ? (
        <ErrorState
          error={error}
          resource="usage"
          onRetry={() => {
            void usage.refetch();
            void org.refetch();
          }}
        />
      ) : (
        <div className="flex flex-col gap-6">
          <Overview usage={usage.data} org={org.data} canEdit={canEdit} onEditCap={() => setCapOpen(true)} />
          <ByKind usage={usage.data} />
          <PlanComparison current={org.data.plan} />
          {capOpen && <SpendCapDialog open={capOpen} onOpenChange={setCapOpen} org={org.data} />}
        </div>
      )}
    </Page>
  );
}
