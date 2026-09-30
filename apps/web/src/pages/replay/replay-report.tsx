import type { Replay } from "@slai/shared";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  EmptyState,
  formatDate,
  formatMoney,
  formatNumber,
  formatPercent,
  LogoMark,
  Skeleton,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from "@slai/ui";
import { getRouteApi, Link } from "@tanstack/react-router";
import { ArrowLeft, BellRing, CircleAlert, Link2, Printer, Scale } from "lucide-react";
import { Page, QueryState } from "../../components/page";
import { METRIC_LABEL, providerLabel } from "../../lib/labels";
import { useConnections, useMe, useReplay } from "../../lib/queries";
import { copyText } from "../connections/connections";
import { leadTime, ReplayProgress, ReplayStatusBadge } from "./replay-parts";

const route = getRouteApi("/_app/replay/$replayId");

const PRINT_CSS = `
@media print {
  @page { margin: 14mm; }
  html, body { background: #fff !important; }
  aside, body header.sticky { display: none !important; }
  [data-print-hide] { display: none !important; }
  [data-report] { max-width: none !important; padding: 0 !important; }
}`;

function Bar({ value, max, tone = "breached" }: { value: number; max: number; tone?: "breached" | "accent" }) {
  const pct = max > 0 && value > 0 ? Math.max(2, (value / max) * 100) : 0;
  return (
    <span aria-hidden className="block h-2 w-full overflow-hidden rounded-full bg-sunken">
      <span
        className={
          tone === "breached" ? "block h-full rounded-full bg-breached" : "block h-full rounded-full bg-accent"
        }
        style={{ width: `${pct}%` }}
      />
    </span>
  );
}

function Report({ replay }: { replay: Replay }) {
  const me = useMe();
  const connections = useConnections();
  const connection = connections.data?.items.find((c) => c.id === replay.connectionId);
  const end = new Date(replay.createdAt);
  const start = new Date(end.getTime() - replay.days * 86_400_000);
  const result = replay.result;
  const orgName = me.data?.organization.name ?? "Your organization";

  const actions = (
    <div className="flex items-center gap-2" data-print-hide>
      <Button leadingIcon={<Link2 />} onClick={() => copyText(window.location.href, "Report link")}>
        Copy link
      </Button>
      <Button leadingIcon={<Printer />} onClick={() => window.print()} disabled={!result}>
        Print / Save PDF
      </Button>
    </div>
  );

  return (
    <div className="flex flex-col gap-6">
      <style>{PRINT_CSS}</style>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="mb-2 flex items-center gap-2 text-xs font-medium text-ink-muted">
            <LogoMark className="size-4" />
            <span>Breach Replay · {orgName}</span>
          </div>
          <h1 className="text-3xl font-semibold tracking-tight text-ink">Breach Replay — last {replay.days} days</h1>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-muted">
            <span>
              {formatDate(start)} – {formatDate(end)}
            </span>
            <span aria-hidden>·</span>
            <span>{connection ? `${connection.name} (${providerLabel(connection.provider)})` : "Help desk"}</span>
            <ReplayStatusBadge status={replay.status} />
          </p>
        </div>
        {actions}
      </div>

      {(replay.status === "queued" || replay.status === "running") && (
        <Card className="p-6">
          <h2 className="text-md font-semibold text-ink">Replaying your history</h2>
          <p className="mt-1 text-sm text-ink-muted">
            Every ticket is checked again, exactly, against the policy that applied at the time.
          </p>
          <ReplayProgress replay={replay} className="mt-5" />
        </Card>
      )}

      {replay.status === "failed" && (
        <Card>
          <EmptyState
            tone="error"
            icon={<CircleAlert />}
            title="This replay failed"
            description="slai couldn't finish reading your ticket history. Check the connection, then run the replay again."
            action={
              <Button asChild size="sm">
                <Link to="/replay">Back to replays</Link>
              </Button>
            }
          />
        </Card>
      )}

      {result && (
        <>
          <section
            aria-label="Summary"
            className="relative overflow-hidden rounded-xl border border-line bg-surface p-6 shadow-xs md:p-8"
          >
            <div className="grid gap-8 md:grid-cols-[1.3fr_1fr]">
              <div>
                <p className="text-sm font-medium text-ink-muted">Service credits you were exposed to</p>
                <p className="mt-2 font-mono text-5xl font-medium tracking-tighter text-breached-text tnum md:text-6xl">
                  {formatMoney(result.exposureCents)}
                </p>
                <p className="mt-3 max-w-md text-sm text-ink-muted">
                  <strong className="font-semibold text-ink">{formatNumber(result.breaches)} breaches</strong> across{" "}
                  {formatNumber(result.tickets)} tickets, priced with the credit clauses in your contracts.
                </p>
              </div>
              <dl className="grid grid-cols-2 content-start gap-x-6 gap-y-5">
                <div>
                  <dt className="text-xs text-ink-muted">Attainment</dt>
                  <dd className="mt-1 font-mono text-2xl text-ink tnum">{formatPercent(result.attainmentPercent)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-ink-muted">Breach rate</dt>
                  <dd className="mt-1 font-mono text-2xl text-ink tnum">
                    {formatPercent(result.tickets ? (result.breaches / result.tickets) * 100 : null)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-ink-muted">Tickets replayed</dt>
                  <dd className="mt-1 font-mono text-2xl text-ink tnum">{formatNumber(result.tickets)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-ink-muted">Median warning</dt>
                  <dd className="mt-1 font-mono text-2xl text-accent-text tnum">
                    {leadTime(result.medianLeadMinutes)}
                  </dd>
                </div>
              </dl>
            </div>
            {result.medianLeadMinutes !== null && (
              <p className="mt-8 flex items-start gap-3 rounded-lg border border-accent/20 bg-accent-subtle px-4 py-3 text-sm text-ink">
                <BellRing className="mt-0.5 size-4 shrink-0 text-accent-text" aria-hidden />
                <span>
                  slai would have warned you a median{" "}
                  <strong className="font-semibold text-accent-text">{leadTime(result.medianLeadMinutes)}</strong>{" "}
                  before each breach, enough time to answer, escalate, or let an agent draft the reply.
                </span>
              </p>
            )}
          </section>

          <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
            <Card>
              <CardHeader title="By customer" description="Where the exposure concentrates." />
              <CardContent className="px-0 pb-2">
                {result.byCustomer.length === 0 ? (
                  <EmptyState compact title="No breaches by customer" />
                ) : (
                  <Table aria-label="Breaches and exposure by customer" containerClassName="border-t border-line">
                    <THead>
                      <tr>
                        <TH className="pl-5">Customer</TH>
                        <TH align="right">Breaches</TH>
                        <TH align="right">Exposure</TH>
                        <TH className="hidden w-[30%] sm:table-cell">
                          <span className="sr-only">Share of exposure</span>
                        </TH>
                      </tr>
                    </THead>
                    <TBody>
                      {(() => {
                        const max = Math.max(...result.byCustomer.map((c) => c.exposureCents));
                        return [...result.byCustomer]
                          .sort((a, b) => b.exposureCents - a.exposureCents)
                          .map((c) => (
                            <TR key={c.customerId ?? c.name}>
                              <TD className="pl-5 font-medium">
                                {c.customerId ? c.name : <span className="text-ink-muted">{c.name}</span>}
                              </TD>
                              <TD numeric>{formatNumber(c.breaches)}</TD>
                              <TD numeric className="text-ink">
                                {formatMoney(c.exposureCents)}
                              </TD>
                              <TD className="hidden pr-5 sm:table-cell">
                                <Bar value={c.exposureCents} max={max} />
                              </TD>
                            </TR>
                          ));
                      })()}
                    </TBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader title="By metric" description="Breaches out of SLA targets measured." />
              <CardContent>
                <ul className="flex flex-col gap-4">
                  {result.byMetric.map((m) => {
                    const rate = m.measured ? (m.breaches / m.measured) * 100 : 0;
                    return (
                      <li key={m.metric}>
                        <div className="mb-1.5 flex items-baseline justify-between gap-3 text-sm">
                          <span className="font-medium text-ink">{METRIC_LABEL[m.metric]}</span>
                          <span className="font-mono text-xs text-ink-muted tnum">
                            {formatNumber(m.breaches)} / {formatNumber(m.measured)} ·{" "}
                            <span className="text-ink">{formatPercent(rate)}</span>
                          </span>
                        </div>
                        <Bar
                          value={rate}
                          max={Math.max(
                            ...result.byMetric.map((x) => (x.measured ? (x.breaches / x.measured) * 100 : 0)),
                          )}
                          tone="accent"
                        />
                      </li>
                    );
                  })}
                </ul>
              </CardContent>
            </Card>
          </div>

          <Card className="flex gap-3 p-5">
            <Scale className="mt-0.5 size-5 shrink-0 text-ink-muted" aria-hidden />
            <div className="text-sm text-ink-muted">
              <h2 className="font-semibold text-ink">Methodology</h2>
              <p className="mt-1 max-w-3xl leading-relaxed">
                Every number here is calculated exactly from your contracts and each ticket's history, never guessed by
                AI. Each ticket's history is replayed against the policy version that applied at the time, on the
                contract's business calendar (time zone, working hours, holidays) with its pause rules. A breach is
                elapsed time strictly past the target. Exposure applies each contract's credit clauses, including caps.
                Warning lead time is measured from the first at-risk alert slai would have raised to the breach.
              </p>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

export function ReplayReportPage() {
  const { replayId } = route.useParams();
  const query = useReplay(replayId);
  return (
    <Page docTitle="Breach Replay report" width="default" className="print:max-w-none">
      <div data-report>
        <div className="mb-4" data-print-hide>
          <Button asChild variant="ghost" size="sm" className="-ml-2">
            <Link to="/replay">
              <ArrowLeft aria-hidden /> All replays
            </Link>
          </Button>
        </div>
        <QueryState
          query={query}
          resource="this report"
          loading={
            <div className="flex flex-col gap-4" role="status" aria-label="Loading report">
              <Skeleton className="h-10 w-2/3" />
              <Skeleton className="h-56 rounded-xl" />
              <Skeleton className="h-64 rounded-lg" />
            </div>
          }
        >
          {(replay) => <Report replay={replay} />}
        </QueryState>
      </div>
    </Page>
  );
}
