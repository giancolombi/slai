import {
  Button,
  Card,
  CardContent,
  CardHeader,
  EmptyState,
  formatDateTime,
  formatMoney,
  formatNumber,
  formatPercent,
  Skeleton,
} from "@slai/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowRight, Cable, History } from "lucide-react";
import { ErrorState, Page, QueryState } from "../../components/page";
import { GuideButton } from "../../help/guide-button";
import { providerLabel } from "../../lib/labels";
import { useConnections, useReplays } from "../../lib/queries";
import { leadTime, ReplayProgress, ReplayStatusBadge, RunReplayForm } from "./replay-parts";

export function ReplaysPage() {
  const replays = useReplays();
  const connections = useConnections();
  const navigate = useNavigate();
  const connName = (id: string) => {
    const c = connections.data?.items.find((x) => x.id === id);
    return c ? `${c.name} · ${providerLabel(c.provider)}` : "Removed connection";
  };

  return (
    <Page
      title="Breach Replay"
      description="Replay past tickets against your approved contracts: every breach you missed, what it cost in credits, and how early slai would have warned you."
    >
      <div className="grid items-start gap-6 lg:grid-cols-[1fr_340px]">
        <section aria-labelledby="replays-h" className="flex flex-col gap-3">
          <h2 id="replays-h" className="sr-only">
            Past replays
          </h2>
          <QueryState
            query={replays}
            resource="replays"
            loading={
              <div className="flex flex-col gap-3" role="status" aria-label="Loading replays">
                {[0, 1].map((i) => (
                  <Skeleton key={i} className="h-32 rounded-lg" />
                ))}
              </div>
            }
            isEmpty={(d) => d.items.length === 0}
            empty={
              <Card>
                <EmptyState
                  icon={<History />}
                  title="No replays yet"
                  description="Run your first replay to see the last 90 days through your contracts. It takes about a minute."
                  action={<GuideButton guide="replay" />}
                />
              </Card>
            }
          >
            {(data) =>
              data.items.map((r) => (
                <Card key={r.id} interactive className="p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <h3 className="text-md font-semibold text-ink">Last {r.days} days</h3>
                        <ReplayStatusBadge status={r.status} />
                      </div>
                      <p className="mt-0.5 text-xs text-ink-muted">
                        {connName(r.connectionId)} · started {formatDateTime(r.createdAt)}
                      </p>
                    </div>
                    {r.status === "succeeded" && (
                      <Button asChild size="sm" variant="ghost" className="-mr-2 shrink-0">
                        <Link to="/replay/$replayId" params={{ replayId: r.id }}>
                          Open report <ArrowRight aria-hidden />
                        </Link>
                      </Button>
                    )}
                  </div>
                  {(r.status === "queued" || r.status === "running") && <ReplayProgress replay={r} className="mt-4" />}
                  {r.status === "failed" && (
                    <p className="mt-3 text-sm text-breached-text">
                      The replay failed. Check the connection and run it again.
                    </p>
                  )}
                  {r.result && (
                    <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
                      {[
                        ["Exposure", formatMoney(r.result.exposureCents)],
                        ["Breaches", formatNumber(r.result.breaches)],
                        ["Attainment", formatPercent(r.result.attainmentPercent)],
                        ["Median warning", leadTime(r.result.medianLeadMinutes)],
                      ].map(([k, v]) => (
                        <div key={k}>
                          <dt className="text-xs text-ink-muted">{k}</dt>
                          <dd className="font-mono text-lg text-ink tnum">{v}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </Card>
              ))
            }
          </QueryState>
        </section>

        <Card className="lg:sticky lg:top-20">
          <CardHeader title="Run a new replay" description="Read-only. Nothing is written to your help desk." />
          <CardContent>
            {connections.isPending ? (
              <Skeleton className="h-40" />
            ) : connections.isError ? (
              <ErrorState
                compact
                error={connections.error}
                resource="connections"
                onRetry={() => connections.refetch()}
              />
            ) : connections.data.items.length === 0 ? (
              <EmptyState
                compact
                icon={<Cable />}
                title="Connect a help desk first"
                action={
                  <Button asChild size="sm" variant="primary">
                    <Link to="/connections">Add connection</Link>
                  </Button>
                }
              />
            ) : (
              <RunReplayForm
                connections={connections.data.items}
                onStarted={(r) => navigate({ to: "/replay/$replayId", params: { replayId: r.id } })}
              />
            )}
          </CardContent>
        </Card>
      </div>
    </Page>
  );
}
