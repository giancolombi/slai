import type { DashboardSummary, Risk, TicketSummary } from "@slai/shared";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  cn,
  EmptyState,
  formatMoney,
  formatNumber,
  formatPercent,
  RISK_META,
  RISKS,
  RiskBadge,
  Skeleton,
  SlaClock,
  Sparkline,
  Stat,
} from "@slai/ui";
import { Link } from "@tanstack/react-router";
import {
  ArrowRight,
  CircleCheck,
  Gauge,
  HandCoins,
  Inbox,
  OctagonX,
  Plug,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { ErrorState, Page } from "../../components/page";
import { METRIC_LABEL, PRIORITY_LABEL } from "../../lib/labels";
import { useDashboard, useMe } from "../../lib/queries";
import { AttainmentChart, BreachBars, TrendTable, useActiveIndex } from "./charts";

const periodFmt = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

export function DashboardPage() {
  const query = useDashboard();
  const me = useMe();
  const firstName = me.data?.user.name.split(" ")[0];
  const period = query.data ? periodFmt.format(new Date(query.data.period.start)) : null;

  return (
    <Page
      title="Dashboard"
      docTitle="Dashboard"
      eyebrow={period ? `${period} · period to date` : "This period"}
      description={
        firstName ? `Good to see you, ${firstName}. Here is where every contract stands right now.` : undefined
      }
      actions={
        <Button asChild variant="secondary" size="sm">
          <Link to="/tickets" search={{ risk: "at_risk" }}>
            Work the at-risk queue <ArrowRight aria-hidden />
          </Link>
        </Button>
      }
      width="wide"
    >
      {query.isPending ? (
        <DashboardSkeleton />
      ) : query.isError ? (
        <Card>
          <ErrorState error={query.error} resource="the dashboard" onRetry={() => query.refetch()} />
        </Card>
      ) : query.data.openTickets === 0 && query.data.attainmentTrend.length === 0 ? (
        <EmptyDashboard />
      ) : (
        <DashboardBody data={query.data} />
      )}
    </Page>
  );
}

function DashboardBody({ data }: { data: DashboardSummary }) {
  const hot = data.byRisk.at_risk + data.byRisk.breached;
  const trendValues = data.attainmentTrend.map((d) => d.percent);
  const chart = useActiveIndex(data.attainmentTrend.length);
  const firstPct = data.attainmentTrend.find((d) => d.percent !== null)?.percent ?? null;
  const delta = data.attainmentPercent !== null && firstPct !== null ? data.attainmentPercent - firstPct : null;

  return (
    <div className="flex flex-col gap-5">
      <section aria-label="Key numbers" className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Link
          to="/tickets"
          search={{ risk: "at_risk" }}
          className="group rounded-lg focus-visible:outline-offset-2"
          aria-label={`${hot} tickets at risk or breached now. View at-risk tickets`}
        >
          <Stat
            className={cn(
              "h-full transition-colors group-hover:border-line-strong",
              hot > 0 && "border-at-risk-border",
            )}
            icon={<TriangleAlert className={hot > 0 ? "text-at-risk-text" : undefined} />}
            label="At risk now"
            value={hot}
            detail={
              <span className="flex flex-wrap gap-x-3">
                <span className="text-at-risk-text">{data.byRisk.at_risk} at risk</span>
                <span className="text-breached-text">{data.byRisk.breached} breached</span>
                <span>{formatNumber(data.openTickets)} open</span>
              </span>
            }
          />
        </Link>
        <Stat
          icon={<Gauge />}
          label="Attainment"
          value={formatPercent(data.attainmentPercent)}
          detail={
            delta === null
              ? "Met ÷ (met + breached) cycles"
              : `${delta >= 0 ? "+" : "−"}${Math.abs(delta).toFixed(1)} pts over ${data.attainmentTrend.length} days`
          }
          detailTone={delta === null ? "neutral" : delta >= 0 ? "good" : "bad"}
          trend={
            <Sparkline
              values={trendValues}
              width={84}
              height={30}
              label={`Attainment trend, ${formatPercent(firstPct)} to ${formatPercent(data.attainmentPercent)}`}
            />
          }
        />
        <Stat
          icon={<OctagonX />}
          label="Breaches this period"
          value={data.breachesThisPeriod}
          detail={
            <>
              <span className="font-mono tnum text-ink">{formatMoney(data.exposureCents)}</span> credit exposure
            </>
          }
          detailTone="bad"
        />
        <Stat
          icon={<ShieldCheck />}
          label="Breaches saved"
          value={data.savedBreaches}
          detail={
            <>
              <span className="font-mono tnum">{formatMoney(data.savedCents)}</span> in credits avoided
            </>
          }
          detailTone="good"
        />
        <Link
          to="/approvals"
          className="group rounded-lg"
          aria-label={`${data.pendingApprovals} drafts awaiting approval`}
        >
          <Stat
            className="h-full transition-colors group-hover:border-line-strong"
            icon={<Inbox />}
            label="Pending approvals"
            value={data.pendingApprovals}
            detail={
              <span className="inline-flex items-center gap-1 text-accent-text">
                Open inbox <ArrowRight className="size-3" aria-hidden />
              </span>
            }
          />
        </Link>
      </section>

      <Card>
        <CardHeader
          title="Open tickets by risk"
          description="Worst live SLA metric per ticket, from the deterministic clock."
        />
        <CardContent>
          <RiskDistribution byRisk={data.byRisk} />
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader
            title="Attainment, last 30 days"
            description="Share of SLA cycles met each day, across every policy."
            actions={
              data.attainmentPercent !== null ? (
                <span className="font-mono text-sm text-ink tnum">{formatPercent(data.attainmentPercent)}</span>
              ) : null
            }
          />
          <CardContent className="flex flex-col gap-4">
            {data.attainmentTrend.length > 1 ? (
              <>
                <AttainmentChart data={data.attainmentTrend} {...chart} />
                <div>
                  <p className="mb-1.5 text-xs font-medium text-ink-muted">Breaches per day</p>
                  <BreachBars data={data.attainmentTrend} {...chart} />
                </div>
                <TrendTable data={data.attainmentTrend} />
              </>
            ) : (
              <EmptyState
                compact
                icon={<Gauge />}
                title="Not enough history yet"
                description="The trend fills in as tickets close."
              />
            )}
          </CardContent>
        </Card>

        <DueSoon tickets={data.dueSoon} />
      </div>
    </div>
  );
}

function RiskDistribution({ byRisk }: { byRisk: Record<Risk, number> }) {
  const total = RISKS.reduce((s, r) => s + byRisk[r], 0);
  const order: Risk[] = ["breached", "at_risk", "warning", "ok"];
  if (total === 0) return <p className="text-sm text-ink-muted">No open tickets.</p>;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full" aria-hidden>
        {order
          .filter((r) => byRisk[r] > 0)
          .map((r) => (
            <div
              key={r}
              className={cn("h-full first:rounded-l-full last:rounded-r-full", RISK_META[r].solid)}
              style={{ flexGrow: byRisk[r], flexBasis: 0, minWidth: 6 }}
              title={`${RISK_META[r].label}: ${byRisk[r]}`}
            />
          ))}
      </div>
      <ul className="flex flex-wrap gap-x-6 gap-y-2" aria-label="Open tickets by risk">
        {order.map((r) => {
          const Icon = RISK_META[r].icon;
          return (
            <li key={r}>
              <Link
                to="/tickets"
                search={{ risk: r }}
                className="inline-flex items-center gap-1.5 rounded-sm text-sm hover:underline"
              >
                <Icon className={cn("size-4", RISK_META[r].text)} aria-hidden />
                <span className="text-ink">{RISK_META[r].label}</span>
                <span className="font-mono text-ink-muted tnum">{byRisk[r]}</span>
                <span className="text-xs text-ink-subtle tnum">({Math.round((byRisk[r] / total) * 100)}%)</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function DueSoon({ tickets: raw }: { tickets: TicketSummary[] }) {
  // Upcoming deadlines first (soonest on top); anything that tipped over while loaded sinks below.
  const rank = (t: TicketSummary) => t.next?.remainingMs ?? Number.POSITIVE_INFINITY;
  const tickets = [...raw].sort((a, b) => {
    const oa = rank(a) < 0 ? 1 : 0;
    const ob = rank(b) < 0 ? 1 : 0;
    return oa - ob || (oa ? rank(b) - rank(a) : rank(a) - rank(b));
  });
  return (
    <Card className="flex flex-col">
      <CardHeader
        title="Due soon"
        description="Live clocks for tickets past a warning threshold."
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link to="/tickets">All tickets</Link>
          </Button>
        }
      />
      {tickets.length === 0 ? (
        <EmptyState
          compact
          icon={<CircleCheck />}
          title="Nothing is close to breaching"
          description="Every open ticket is under its first warning threshold."
        />
      ) : (
        <ul className="flex flex-col border-t border-line">
          {tickets.map((t) => (
            <li key={t.id} className="border-b border-line last:border-b-0">
              <Link
                to="/tickets/$ticketId"
                params={{ ticketId: t.id }}
                className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-hover focus-visible:-outline-offset-2"
              >
                <RiskBadge risk={t.risk} iconOnly />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="shrink-0 font-mono text-xs text-ink-muted">{t.displayKey}</span>
                    <span className="truncate text-sm font-medium text-ink">{t.subject}</span>
                  </div>
                  <div className="mt-0.5 truncate text-xs text-ink-muted">
                    {[
                      t.customer?.name,
                      t.priority ? PRIORITY_LABEL[t.priority] : null,
                      t.next ? METRIC_LABEL[t.next.metric] : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                </div>
                {t.next && (
                  <SlaClock
                    dueAt={t.next.dueAt}
                    state={t.next.state}
                    remainingMs={t.next.remainingMs}
                    risk={t.risk === "ok" ? undefined : t.risk}
                    size="sm"
                    className="shrink-0"
                  />
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function EmptyDashboard() {
  return (
    <Card>
      <EmptyState
        icon={<Plug />}
        title="Connect a help desk to start the clocks"
        description="slai reads your SLA contracts, runs every ticket on a deterministic clock and warns you before a breach. Setup takes about five minutes."
        action={
          <>
            <Button asChild variant="primary">
              <Link to="/onboarding">Start setup</Link>
            </Button>
            <Button asChild variant="secondary">
              <Link to="/replay">
                <HandCoins aria-hidden /> Run a Breach Replay
              </Link>
            </Button>
          </>
        }
      />
    </Card>
  );
}

function DashboardSkeleton() {
  return (
    <div className="flex flex-col gap-5" role="status" aria-live="polite">
      <span className="sr-only">Loading dashboard…</span>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {["a", "b", "c", "d", "e"].map((k) => (
          <div key={k} className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-7 w-20" />
            <Skeleton className="h-3 w-32" />
          </div>
        ))}
      </div>
      <Skeleton className="h-24 w-full rounded-lg" />
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <Skeleton className="h-80 w-full rounded-lg" />
        <Skeleton className="h-80 w-full rounded-lg" />
      </div>
    </div>
  );
}
