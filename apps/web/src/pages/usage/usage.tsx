import {
  type BillingState,
  type BillingStatus,
  type BillingSummary,
  CHECKOUT_PLANS,
  type CheckoutPlanId,
  CREDIT_PACKS,
  type OrgSettings,
  PLANS,
  type PlanId,
  type UsageSummary,
} from "@slai/shared";
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
  formatDate,
  formatDuration,
  formatMoney,
  formatNumber,
  Input,
  SegmentedControl,
  Select,
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
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  AlertTriangle,
  BellRing,
  Check,
  Clock,
  Coins,
  CreditCard,
  ExternalLink,
  Info,
  Pencil,
  Receipt,
  Wrench,
} from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { MOCK_MODE } from "../../app-layout";
import { NOTICE_CLASS } from "../../components/billing-banner";
import { ErrorState, Page } from "../../components/page";
import { GuideButton } from "../../help/guide-button";
import { WhatsThis } from "../../help/whats-this";
import { api, errorMessage } from "../../lib/api";
import {
  billingNotice,
  CEILING_HELP,
  CEILING_LABEL,
  creditMeter,
  planName,
  planPrice,
  prepaidCredits,
  STATE_META,
  usd,
} from "../../lib/billing";
import {
  qk,
  useBilling,
  useBillingPortal,
  useCheckout,
  useCreditPackCheckout,
  useManualBilling,
  useMe,
  useOrg,
  useUsage,
} from "../../lib/queries";
import type { BillingSearch } from "../../router";
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

const errorToast = (title: string) => (description: string) => toast({ tone: "error", title, description });

// ---------------------------------------------------------------- spend cap

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
      void queryClient.invalidateQueries({ queryKey: qk.billing });
      toast({
        tone: "success",
        title: "Spend cap updated",
        description:
          next.monthlySpendCapCents === null
            ? "Back to the default cap."
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
      description="Caps AI credits (1 credit = 1¢). At the cap, agents step down to observe. SLA monitoring and alerts continue."
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
        <Field label="Cap per month (USD)" error={error ?? undefined}>
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
        <Field label="Use the default cap" hint="Included + purchased credits, plus 50% of included." inline>
          <Checkbox checked={noCap} onCheckedChange={(v) => setNoCap(v === true)} />
        </Field>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------- credit packs

function CreditPackDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [pack, setPack] = useState(CREDIT_PACKS[0]!.id);
  const buy = useCreditPackCheckout({ onError: errorToast("Couldn't start checkout") });
  const selected = CREDIT_PACKS.find((p) => p.id === pack) ?? CREDIT_PACKS[0]!;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Buy credits"
      description="Credit packs top up this period and carry over until used. 1 credit = 1¢ of agent work."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            leadingIcon={<CreditCard />}
            loading={buy.isPending || buy.isSuccess}
            onClick={() => buy.mutate({ pack })}
          >
            Continue to payment
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <SegmentedControl
          aria-label="Credit pack"
          value={pack}
          onValueChange={setPack}
          options={CREDIT_PACKS.map((p) => ({ value: p.id, label: `${formatNumber(p.credits)} credits` }))}
        />
        <p className="text-sm text-ink-muted">
          <span className="font-mono text-lg font-medium text-ink tnum">{usd(selected.priceCents)}</span> for{" "}
          {formatNumber(selected.credits)} credits
          {selected.priceCents < selected.credits && (
            <Badge tone="ok" size="sm" className="ml-2">
              Save {Math.round((1 - selected.priceCents / selected.credits) * 100)}%
            </Badge>
          )}
        </p>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- notices

function Notice({ billing }: { billing: BillingSummary }) {
  const notice = billingNotice(billing);
  if (!notice) return null;
  const Icon = billing.state === "trialing" ? Clock : AlertTriangle;
  return (
    <section
      aria-label="Billing status"
      className={cn("flex gap-3 rounded-lg border px-4 py-3 text-sm", NOTICE_CLASS[notice.tone])}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div>
        <p className="font-medium">{notice.title}</p>
        <p className="mt-0.5 text-ink-muted">{notice.message}</p>
      </div>
    </section>
  );
}

function stateDetail(b: BillingSummary): string | null {
  if (b.state === "trialing" && b.trialEndsAt) return `Trial ends ${formatDate(b.trialEndsAt)}`;
  if (b.state === "past_due" && b.graceEndsAt) return `Grace period ends ${formatDate(b.graceEndsAt)}`;
  if (b.state === "degraded" && b.pastDueSince) return `Past due since ${formatDate(b.pastDueSince)}`;
  return null;
}

// ---------------------------------------------------------------- current plan

interface Permissions {
  /** Owner or admin. */
  canEdit: boolean;
  /** Stripe actions are live (Stripe mode and owner/admin). */
  canPay: boolean;
}

function PlanCard({
  billing,
  perms,
  onBuyCredits,
}: {
  billing: BillingSummary;
  perms: Permissions;
  onBuyCredits: () => void;
}) {
  const portal = useBillingPortal({ onError: errorToast("Couldn't open billing") });
  const meta = STATE_META[billing.state];
  const detail = stateDetail(billing);
  const choosing = billing.state !== "active" && billing.state !== "past_due";
  return (
    <Card className="flex flex-col p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium text-ink-muted">Current plan</p>
          <p className="mt-1 flex items-center gap-2 text-xl font-semibold tracking-tight text-ink">
            {planName(billing.plan)}
            <Badge tone={meta.tone}>{meta.label}</Badge>
          </p>
          <p className="mt-1 font-mono text-sm text-ink-muted tnum">
            {billing.state === "trialing" ? `Free trial, then ${planPrice(billing.plan)}` : planPrice(billing.plan)}
          </p>
          {detail && <p className="mt-1 text-xs text-ink-muted">{detail}</p>}
        </div>
      </div>

      <div className="mt-4 rounded-md border border-line bg-sunken/60 p-3 text-sm">
        <p className="text-xs font-medium text-ink-muted">What agents may do</p>
        <p className="mt-1 font-medium text-ink">{CEILING_LABEL[billing.ceiling]}</p>
        <p className="text-ink-muted">{CEILING_HELP[billing.ceiling]}</p>
      </div>
      <p className="mt-3 flex gap-2 text-xs text-ink-muted">
        <BellRing className="mt-0.5 size-3.5 shrink-0 text-accent-text" aria-hidden />
        <span>
          <span className="font-medium text-ink">SLA monitoring and alerts are never throttled</span>, on any plan or
          state. Only what agents do changes.
        </span>
      </p>

      <div className="mt-5 flex flex-wrap gap-2">
        {perms.canEdit && (
          <>
            <Button
              variant={choosing ? "primary" : "secondary"}
              size="sm"
              disabled={!perms.canPay}
              asChild={perms.canPay}
            >
              {perms.canPay ? <a href="#plans">{choosing ? "Choose a plan" : "Change plan"}</a> : "Choose a plan"}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              leadingIcon={<Coins />}
              disabled={!perms.canPay}
              onClick={onBuyCredits}
            >
              Buy credits
            </Button>
            {billing.hasCustomer && (
              <Button
                variant="ghost"
                size="sm"
                leadingIcon={<ExternalLink />}
                disabled={!perms.canPay}
                loading={portal.isPending || portal.isSuccess}
                onClick={() => portal.mutate()}
              >
                Manage billing
              </Button>
            )}
          </>
        )}
      </div>
      {!perms.canEdit ? (
        <p className="mt-3 text-xs text-ink-muted">Only owners and admins can change the plan or buy credits.</p>
      ) : billing.mode === "manual" ? (
        <p className="mt-3 flex gap-1.5 text-xs text-ink-muted">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          Billing is managed manually here (local dev, no Stripe keys). Payment actions are off; use the manual controls
          below.
        </p>
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------- meters

function Meters({ billing, canEdit, onEditCap }: { billing: BillingSummary; canEdit: boolean; onEditCap: () => void }) {
  const t = billing.trackedTickets;
  const c = billing.credits;
  const m = creditMeter(c);
  const prepaid = prepaidCredits(c);
  return (
    <Card className="flex flex-col gap-6 p-5">
      <div>
        <div className="flex items-baseline justify-between gap-3">
          <p className="flex items-center gap-1 text-sm font-medium text-ink">
            SLA-tracked tickets <WhatsThis concept="tracked" />
          </p>
          <p className="font-mono text-sm text-ink tnum">
            {formatNumber(t.used)}
            <span className="text-ink-subtle"> / {t.limit === null ? "by contract" : formatNumber(t.limit)}</span>
          </p>
        </div>
        <UsageMeter
          className="mt-2"
          label="SLA-tracked tickets this period"
          value={t.used}
          max={t.limit}
          valueText={
            t.limit === null
              ? `${formatNumber(t.used)} tickets`
              : `${formatNumber(t.used)} of ${formatNumber(t.limit)} tickets`
          }
        />
        <p className={cn("mt-2 text-xs", t.overage > 0 ? "font-medium text-warning-text" : "text-ink-muted")}>
          {t.overage > 0
            ? billing.overageBilled
              ? `${formatNumber(t.overage)} over the limit: ${usd(t.overageCents)} overage at $0.20 a ticket, billed in arrears.`
              : `${formatNumber(t.overage)} over the limit (flagged, not billed during the trial).`
            : "A ticket counts once a month if any SLA clock ran on it. Tracking never stops at the limit."}
        </p>
      </div>

      <div>
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-sm font-medium text-ink">AI credits</p>
          <p className="font-mono text-sm text-ink tnum">
            {formatNumber(c.used)}
            <span className="text-ink-subtle"> / {formatNumber(prepaid)}</span>
          </p>
        </div>
        <UsageMeter
          className="mt-2"
          label="AI credits used this period"
          value={c.used}
          max={m.scale}
          warnAt={m.warnAt}
          breachAt={m.capAt}
          markAt={m.capAt}
          markLabel={`Spend cap: ${formatNumber(c.cap)} credits`}
          valueText={`${formatNumber(c.used)} of ${formatNumber(prepaid)} credits; cap ${formatNumber(c.cap)}`}
        />
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
          {[
            ["Included", c.included],
            ["Purchased", c.purchasedAvailable],
            ["Spend cap", c.cap],
            ["Left before cap", c.remaining],
          ].map(([k, v]) => (
            <div key={k}>
              <dt className="text-ink-muted">{k}</dt>
              <dd className="font-mono text-ink tnum">{formatNumber(v as number)}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <p className={cn("text-xs", m.overCap ? "font-medium text-breached-text" : "text-ink-muted")}>
            {m.overCap
              ? "Spend cap reached: agents are observe-only until the next period or a higher cap."
              : c.overage > 0
                ? `${formatNumber(c.overage)} credits over prepaid${billing.overageBilled ? ` (${usd(c.overageCents)}, billed in arrears)` : ""}.`
                : c.capOverrideCents === null
                  ? "Default cap: included + purchased, plus 50% of included."
                  : "Custom spend cap."}
          </p>
          {canEdit && (
            <Button size="sm" variant="ghost" leadingIcon={<Pencil />} onClick={onEditCap}>
              Edit cap
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- usage by kind

function ByKind({ usage }: { usage: UsageSummary }) {
  const total = usage.byKind.reduce((s, k) => s + k.credits, 0) || 1;
  const rows = [...usage.byKind].sort((a, b) => b.credits - a.credits);
  return (
    <Card>
      <CardHeader title="Credits by kind" description="Every model call and sandbox second is metered." />
      {rows.length === 0 ? (
        <EmptyState
          compact
          icon={<Receipt />}
          title="No usage yet this period"
          description="Agent runs, contract extraction and previews will appear here."
          action={<GuideButton guide="billing" anchor="credits" />}
        />
      ) : (
        <Table aria-label="Credits by kind">
          <THead>
            <tr>
              <TH>Kind</TH>
              <TH align="right">Count</TH>
              <TH align="right">Credits</TH>
              <TH className="w-[32%]">Share</TH>
            </tr>
          </THead>
          <TBody>
            {rows.map((k) => {
              const meta = kindMeta(k.kind);
              const share = k.credits / total;
              return (
                <TR key={k.kind}>
                  <TD>
                    <div className="font-medium text-ink">{meta.label}</div>
                    {meta.help && <div className="text-xs text-ink-muted">{meta.help}</div>}
                  </TD>
                  <TD numeric>{meta.unit === "seconds" ? formatDuration(k.count * 1000) : formatNumber(k.count)}</TD>
                  <TD numeric>{formatNumber(k.credits)}</TD>
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

// ---------------------------------------------------------------- invoices

function Invoices({ billing }: { billing: BillingSummary }) {
  if (billing.invoices.length === 0) return null;
  return (
    <Card>
      <CardHeader title="Invoices" />
      <Table aria-label="Invoices">
        <THead>
          <tr>
            <TH>Date</TH>
            <TH>Invoice</TH>
            <TH>Status</TH>
            <TH align="right">Amount</TH>
            <TH align="right">
              <span className="sr-only">Links</span>
            </TH>
          </tr>
        </THead>
        <TBody>
          {billing.invoices.map((inv) => (
            <TR key={inv.id}>
              <TD>{formatDate(inv.createdAt)}</TD>
              <TD className="font-mono text-xs">{inv.number ?? "—"}</TD>
              <TD>
                <Badge size="sm" tone={inv.status === "paid" ? "ok" : inv.status === "open" ? "warning" : "neutral"}>
                  {inv.status ? inv.status.replace(/^\w/, (ch) => ch.toUpperCase()) : "—"}
                </Badge>
              </TD>
              <TD numeric>{usd(inv.status === "paid" ? inv.amountPaidCents : inv.amountDueCents)}</TD>
              <TD align="right">
                <span className="inline-flex gap-3 text-xs">
                  {inv.hostedUrl && (
                    <a href={inv.hostedUrl} target="_blank" rel="noreferrer" className="text-accent-text underline">
                      View
                    </a>
                  )}
                  {inv.pdfUrl && (
                    <a href={inv.pdfUrl} target="_blank" rel="noreferrer" className="text-accent-text underline">
                      PDF
                    </a>
                  )}
                </span>
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </Card>
  );
}

// ---------------------------------------------------------------- plan comparison

const COMPARED: PlanId[] = ["starter", "growth", "scale", "enterprise"];

function isCheckoutPlan(id: PlanId): id is CheckoutPlanId {
  return (CHECKOUT_PLANS as readonly string[]).includes(id);
}

function PlanComparison({ billing, perms }: { billing: BillingSummary; perms: Permissions }) {
  const checkout = useCheckout({ onError: errorToast("Couldn't start checkout") });
  const subscribed = billing.state === "active" || billing.state === "past_due" || billing.state === "degraded";
  return (
    <section aria-labelledby="plans-heading" id="plans" className="scroll-mt-20">
      <div className="mb-3">
        <h2 id="plans-heading" className="text-md font-semibold text-ink">
          Plans
        </h2>
        <p className="text-sm text-ink-muted">
          Priced by SLA-tracked tickets plus prepaid AI credits. No per-seat pricing. Monitoring and alerts on every
          plan.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {COMPARED.map((id) => {
          const p = PLANS[id];
          const isCurrent = id === billing.plan;
          const owned = isCurrent && subscribed;
          const pending = checkout.isPending && checkout.variables?.plan === id;
          return (
            <Card
              key={id}
              className={cn("flex flex-col p-5", isCurrent && "border-accent shadow-sm ring-1 ring-accent/30")}
            >
              <div className="flex items-center justify-between gap-2">
                <p className="font-semibold text-ink">{p.name}</p>
                {isCurrent && (
                  <Badge tone="accent" size="sm" icon={<Check />}>
                    {billing.state === "trialing" ? "Trial" : "Current"}
                  </Badge>
                )}
              </div>
              <p className="mt-3 font-mono text-2xl font-medium tracking-tight text-ink tnum">
                {p.priceCents === null ? "Custom" : usd(p.priceCents)}
                {p.priceCents !== null && (
                  <span className="font-sans text-sm font-normal text-ink-muted"> / month</span>
                )}
              </p>
              <p className="mt-1 text-sm text-ink-muted">{p.summary}</p>
              <ul className="mt-4 flex flex-1 flex-col gap-1.5 text-sm text-ink-muted">
                <li className="flex gap-2">
                  <Check className="mt-0.5 size-4 shrink-0 text-ok-text" aria-hidden />
                  {p.trackedTickets === null
                    ? "Tracked tickets by contract"
                    : `${formatNumber(p.trackedTickets)} tracked tickets / month`}
                </li>
                <li className="flex gap-2">
                  <Check className="mt-0.5 size-4 shrink-0 text-ok-text" aria-hidden />
                  {formatNumber(p.includedCredits)} AI credits included
                </li>
                <li className="flex gap-2">
                  <Check className="mt-0.5 size-4 shrink-0 text-ok-text" aria-hidden />
                  <span>
                    <span className="font-medium text-ink">{CEILING_LABEL[p.ceiling]}:</span>{" "}
                    {CEILING_HELP[p.ceiling].replace(/^Agents /, "agents ")}
                  </span>
                </li>
                {p.ticketOverageCents !== null && (
                  <li className="flex gap-2">
                    <Check className="mt-0.5 size-4 shrink-0 text-ok-text" aria-hidden />
                    {usd(p.ticketOverageCents)} per ticket over the limit
                  </li>
                )}
              </ul>
              {isCheckoutPlan(id) ? (
                <Button
                  className="mt-5"
                  variant={owned ? "secondary" : "primary"}
                  disabled={owned || !perms.canPay || checkout.isPending || checkout.isSuccess}
                  loading={pending}
                  onClick={() => checkout.mutate({ plan: id })}
                >
                  {owned ? "Your plan" : `Choose ${p.name}`}
                </Button>
              ) : (
                <Button className="mt-5" variant="secondary" asChild>
                  <a href="mailto:sales@slai.example?subject=Enterprise%20plan">Contact sales</a>
                </Button>
              )}
            </Card>
          );
        })}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- manual mode (local dev, demo)

const STATUS_OPTIONS: { value: BillingStatus; label: string }[] = [
  { value: "trialing", label: "Trialing" },
  { value: "active", label: "Active" },
  { value: "past_due", label: "Past due" },
  { value: "canceled", label: "Canceled" },
];

const DAY_MS = 86_400_000;

function ManualBilling({ billing }: { billing: BillingSummary }) {
  const manual = useManualBilling({ onError: errorToast("Couldn't update billing") });
  const set = (body: Parameters<typeof manual.mutate>[0], label: string) =>
    manual.mutate(body, { onSuccess: () => toast({ tone: "success", title: label }) });
  const inDays = (d: number) => new Date(Date.now() + d * DAY_MS - 3_600_000).toISOString();
  const presets: { label: string; state: BillingState; run: () => void }[] = [
    {
      label: "Trial, 9 days left",
      state: "trialing",
      run: () => set({ status: "trialing", trialEndsAt: inDays(9) }, "Trial: 9 days left"),
    },
    {
      label: "Trial, 2 days left",
      state: "trialing",
      run: () => set({ status: "trialing", trialEndsAt: inDays(2) }, "Trial: 2 days left"),
    },
    {
      label: "Trial ended",
      state: "trial_expired",
      run: () => set({ status: "trialing", trialEndsAt: new Date(Date.now() - DAY_MS).toISOString() }, "Trial ended"),
    },
    {
      label: "Past due (in grace)",
      state: "past_due",
      run: () => set({ status: "past_due", pastDueSince: new Date(Date.now() - 2 * DAY_MS).toISOString() }, "Past due"),
    },
    {
      label: "Past due (degraded)",
      state: "degraded",
      run: () =>
        set({ status: "past_due", pastDueSince: new Date(Date.now() - 10 * DAY_MS).toISOString() }, "Degraded"),
    },
  ];
  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <Wrench className="size-4 text-ink-muted" aria-hidden /> Manual billing
          </span>
        }
        description={
          billing.mode === "manual"
            ? "No Stripe keys are configured (local dev), so an admin sets the plan directly."
            : "Demo data: set the plan and state directly to preview each billing screen."
        }
      />
      <div className="flex flex-col gap-4 px-5 pb-5">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Plan">
            <Select
              value={billing.plan}
              onValueChange={(v) => set({ plan: v as PlanId }, `Plan set to ${planName(v)}`)}
              options={(Object.keys(PLANS) as PlanId[]).map((id) => ({ value: id, label: PLANS[id].name }))}
              disabled={manual.isPending}
            />
          </Field>
          <Field label="Status">
            <Select
              value={billing.status}
              onValueChange={(v) => set({ status: v as BillingStatus }, "Status updated")}
              options={STATUS_OPTIONS}
              disabled={manual.isPending}
            />
          </Field>
          <Button
            variant="secondary"
            leadingIcon={<Coins />}
            disabled={manual.isPending}
            onClick={() => set({ grantCredits: 10_000 }, "Granted 10,000 credits")}
          >
            Grant 10,000 credits
          </Button>
        </div>
        <div className="flex flex-wrap gap-2">
          {presets.map((p) => (
            <Button
              key={p.label}
              size="sm"
              variant={billing.state === p.state ? "secondary" : "ghost"}
              disabled={manual.isPending}
              onClick={p.run}
            >
              {p.label}
            </Button>
          ))}
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- page

function BillingSkeleton() {
  return (
    <div className="flex flex-col gap-5" role="status" aria-live="polite">
      <span className="sr-only">Loading billing…</span>
      <div className="grid gap-4 lg:grid-cols-2">
        {[0, 1].map((i) => (
          <Skeleton key={i} className="h-72 rounded-lg" />
        ))}
      </div>
      <Skeleton className="h-72 rounded-lg" />
    </div>
  );
}

/** Toasts once on return from Stripe Checkout or the Customer Portal, then clears the query string. */
function useReturnToast() {
  const search = useSearch({ strict: false }) as BillingSearch;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { checkout, credits, portal } = search;
  useEffect(() => {
    if (!checkout && !credits && !portal) return;
    if (checkout === "success")
      toast({ tone: "success", title: "You're subscribed", description: "Thanks! Your plan is active." });
    if (credits === "success") toast({ tone: "success", title: "Credits added" });
    if (checkout === "canceled" || credits === "canceled")
      toast({ title: "Checkout canceled", description: "Nothing was charged." });
    void queryClient.invalidateQueries({ queryKey: qk.billing });
    void queryClient.invalidateQueries({ queryKey: qk.me });
    void navigate({ to: "/billing", search: {}, replace: true });
  }, [checkout, credits, portal, navigate, queryClient]);
}

export function BillingPage() {
  const billing = useBilling();
  const usage = useUsage();
  const org = useOrg();
  const { data: me } = useMe();
  const [capOpen, setCapOpen] = useState(false);
  const [packsOpen, setPacksOpen] = useState(false);
  useReturnToast();
  const canEdit = me?.role === "owner" || me?.role === "admin";
  const perms: Permissions = { canEdit, canPay: canEdit && billing.data?.mode === "stripe" };
  const b = billing.data;
  const period = b
    ? `${periodDate(b.period.start)} – ${periodDate(new Date(new Date(b.period.end).getTime() - 1))}`
    : undefined;

  return (
    <Page title="Billing" description={period ? `Current period: ${period}` : "Plan, usage and invoices."}>
      {billing.isPending ? (
        <BillingSkeleton />
      ) : billing.isError || !b ? (
        <ErrorState error={billing.error} resource="billing" onRetry={() => void billing.refetch()} />
      ) : (
        <div className="flex flex-col gap-6">
          <Notice billing={b} />
          <div className="grid gap-4 lg:grid-cols-2">
            <PlanCard billing={b} perms={perms} onBuyCredits={() => setPacksOpen(true)} />
            <Meters billing={b} canEdit={canEdit && Boolean(org.data)} onEditCap={() => setCapOpen(true)} />
          </div>
          {usage.data && <ByKind usage={usage.data} />}
          <Invoices billing={b} />
          <PlanComparison billing={b} perms={perms} />
          {canEdit && (b.mode === "manual" || MOCK_MODE) && <ManualBilling billing={b} />}
          {capOpen && org.data && <SpendCapDialog open={capOpen} onOpenChange={setCapOpen} org={org.data} />}
          {packsOpen && <CreditPackDialog open={packsOpen} onOpenChange={setPacksOpen} />}
        </div>
      )}
    </Page>
  );
}
