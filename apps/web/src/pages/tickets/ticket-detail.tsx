import type { AgentAction, AgentRun, MetricView, TicketDetail } from "@slai/shared";
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  cn,
  EmptyState,
  formatDateTime,
  formatDuration,
  formatMoney,
  formatRelative,
  Label,
  RiskBadge,
  Skeleton,
  SlaBar,
  SlaClock,
  Switch,
  Textarea,
  TicketTimeline,
  toast,
} from "@slai/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { ArrowLeft, Bot, ExternalLink, FileQuestion, PenLine, ShieldAlert, Sparkles } from "lucide-react";
import { useState } from "react";
import { ErrorState, Page } from "../../components/page";
import { WhatsThis } from "../../help/whats-this";
import { api, errorMessage, isApiError } from "../../lib/api";
import { METRIC_LABEL, providerLabel, STATUS_LABEL } from "../../lib/labels";
import { deciderLabel } from "../../lib/people";
import { usePolicy, useTicket } from "../../lib/queries";
import {
  ActionKindLabel,
  ActionStatusBadge,
  ConfidenceMeter,
  RejectDialog,
  UsedKnowledge,
} from "../approvals/draft-parts";
import { PriorityBadge } from "./priority-badge";

const route = getRouteApi("/_app/tickets/$ticketId");

export function TicketDetailPage() {
  const { ticketId } = route.useParams();
  const query = useTicket(ticketId);

  if (query.isPending) return <DetailSkeleton />;
  if (query.isError) {
    const notFound = isApiError(query.error) && query.error.isNotFound;
    return (
      <Page docTitle="Ticket">
        <BackLink />
        <Card>
          {notFound ? (
            <EmptyState
              icon={<FileQuestion />}
              title="Ticket not found"
              description="It may have been deleted in the help desk, or it belongs to another organization."
              action={
                <Button asChild size="sm">
                  <Link to="/tickets">Back to tickets</Link>
                </Button>
              }
            />
          ) : (
            <ErrorState error={query.error} resource="this ticket" onRetry={() => query.refetch()} />
          )}
        </Card>
      </Page>
    );
  }
  return <TicketView ticket={query.data} />;
}

function BackLink() {
  return (
    <Link
      to="/tickets"
      className="mb-4 inline-flex items-center gap-1.5 rounded-sm text-sm text-ink-muted hover:text-ink"
    >
      <ArrowLeft className="size-4" aria-hidden /> Tickets
    </Link>
  );
}

function TicketView({ ticket: t }: { ticket: TicketDetail }) {
  const policy = usePolicy(t.policy?.id);
  const def = policy.data?.definition as { warnAt?: unknown } | undefined;
  const warnAt =
    Array.isArray(def?.warnAt) && def.warnAt.every((n) => typeof n === "number")
      ? (def.warnAt as number[])
      : [0.5, 0.8];
  const [newestFirst, setNewestFirst] = useState(true);
  const queryClient = useQueryClient();
  const drafts = t.actions.filter((a) => a.status === "proposed" || a.status === "blocked");
  const decided = t.actions.filter((a) => a.status !== "proposed" && a.status !== "blocked");

  const run = useMutation({
    mutationFn: (kind: "triage" | "draft_reply") => api.tickets.runAgent(t.id, kind),
    onSuccess: (_r, kind) => {
      toast({
        tone: "success",
        title: kind === "triage" ? "Triage complete" : "Draft ready for approval",
        description: kind === "draft_reply" ? "Review it below before it's sent." : undefined,
      });
      void queryClient.invalidateQueries({ queryKey: ["ticket", t.id] });
      void queryClient.invalidateQueries({ queryKey: ["actions"] });
    },
    onError: (e) => toast({ tone: "error", title: "The agent run failed", description: errorMessage(e) }),
  });

  const live = t.metrics
    .filter((m) => m.state !== "not_applicable")
    .sort((a, b) => Number(b.metric === t.next?.metric) - Number(a.metric === t.next?.metric));
  const idle = t.metrics.filter((m) => m.state === "not_applicable");

  return (
    <Page docTitle={`${t.displayKey} ${t.subject}`} width="wide">
      <BackLink />
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 max-w-3xl">
          <div className="mb-1.5 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
            <span className="font-mono">{t.displayKey}</span>
            <span aria-hidden>·</span>
            <span>{providerLabel(t.provider)}</span>
            <span aria-hidden>·</span>
            <span>Updated {formatRelative(t.updatedAt)}</span>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">{t.subject}</h1>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <RiskBadge risk={t.risk} />
            <Badge tone="outline">{STATUS_LABEL[t.status]}</Badge>
            {t.priority && <PriorityBadge priority={t.priority} size="md" suffix=" priority" />}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            leadingIcon={<Sparkles aria-hidden />}
            loading={run.isPending && run.variables === "triage"}
            disabled={run.isPending}
            onClick={() => run.mutate("triage")}
          >
            Run triage
          </Button>
          <Button
            size="sm"
            leadingIcon={<PenLine aria-hidden />}
            loading={run.isPending && run.variables === "draft_reply"}
            disabled={run.isPending}
            onClick={() => run.mutate("draft_reply")}
          >
            Draft reply
          </Button>
          {t.url && (
            <Button asChild size="sm" variant="ghost">
              <a href={t.url} target="_blank" rel="noreferrer">
                Open in {providerLabel(t.provider)} <ExternalLink aria-hidden />
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            </Button>
          )}
        </div>
      </header>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-5">
          <section aria-labelledby="clocks-heading">
            <h2 id="clocks-heading" className="sr-only">
              SLA clocks
            </h2>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {live.map((m) => (
                <MetricCard key={m.metric} metric={m} warnAt={warnAt} primary={t.next?.metric === m.metric} />
              ))}
            </div>
            {idle.length > 0 && (
              <p className="mt-2 text-xs text-ink-muted">
                Not measured on this ticket: {idle.map((m) => METRIC_LABEL[m.metric]).join(", ")}.
              </p>
            )}
          </section>

          {drafts.length > 0 && (
            <section aria-labelledby="drafts-heading" className="flex flex-col gap-3">
              <h2 id="drafts-heading" className="text-sm font-semibold text-ink">
                Drafts awaiting approval
              </h2>
              {drafts.map((a) => (
                <DraftCard key={a.id} action={a} ticketId={t.id} />
              ))}
            </section>
          )}

          <Card>
            <CardHeader
              title="Timeline"
              description="Only public agent replies stop response clocks. Internal notes never do."
              actions={
                <div className="flex items-center gap-2">
                  <Switch id="newest-first" checked={newestFirst} onCheckedChange={setNewestFirst} />
                  <Label htmlFor="newest-first" className="text-xs font-normal text-ink-muted">
                    Newest first
                  </Label>
                </div>
              }
            />
            <CardContent>
              {t.timeline.length ? (
                <TicketTimeline items={t.timeline} reverse={newestFirst} />
              ) : (
                <p className="text-sm text-ink-muted">No events yet.</p>
              )}
            </CardContent>
          </Card>
        </div>

        <aside className="flex flex-col gap-5">
          <Card>
            <CardHeader title="Details" as="h2" />
            <CardContent>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2.5 text-sm">
                <dt className="text-ink-muted">Customer</dt>
                <dd className="min-w-0 truncate text-ink">
                  {t.customer ? (
                    <Link to="/tickets" search={{ customerId: t.customer.id }} className="hover:underline">
                      {t.customer.name}
                    </Link>
                  ) : (
                    <span className="text-ink-subtle">Not matched</span>
                  )}
                </dd>
                <dt className="text-ink-muted">Policy</dt>
                <dd className="min-w-0 truncate text-ink">
                  {t.policy ? (
                    <Link to="/policies" search={{ policyId: t.policy.id }} className="hover:underline">
                      {t.policy.name}
                    </Link>
                  ) : (
                    <span className="text-ink-subtle">None (not measured)</span>
                  )}
                </dd>
                <dt className="text-ink-muted">Requester</dt>
                <dd className="min-w-0">
                  <div className="truncate text-ink">{t.requester.name ?? "Unknown"}</div>
                  {t.requester.email && <div className="truncate text-xs text-ink-muted">{t.requester.email}</div>}
                </dd>
                <dt className="text-ink-muted">Assignee</dt>
                <dd className="min-w-0">
                  {t.assigneeName ? (
                    <span className="inline-flex items-center gap-2 text-ink">
                      <Avatar name={t.assigneeName} size="xs" /> {t.assigneeName}
                    </span>
                  ) : (
                    <span className="text-ink-subtle">Unassigned</span>
                  )}
                </dd>
                <dt className="text-ink-muted">Warn at</dt>
                <dd className="font-mono text-xs text-ink tnum">
                  {warnAt.map((w) => `${Math.round(w * 100)}%`).join(" · ")} of target
                </dd>
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader title="Agent runs" as="h2" description="Each run is sandboxed and metered." />
            {t.agentRuns.length ? (
              <ul className="border-t border-line">
                {[...t.agentRuns].reverse().map((r) => (
                  <AgentRunRow key={r.id} run={r} />
                ))}
              </ul>
            ) : (
              <CardContent>
                <p className="text-sm text-ink-muted">No agent has worked this ticket yet.</p>
              </CardContent>
            )}
          </Card>

          {decided.length > 0 && (
            <Card>
              <CardHeader title="Past drafts" as="h2" />
              <ul className="border-t border-line">
                {decided.map((a) => (
                  <li key={a.id} className="flex flex-col gap-1 border-b border-line px-5 py-3 last:border-b-0">
                    <div className="flex items-center justify-between gap-2">
                      <ActionKindLabel kind={a.kind} />
                      <ActionStatusBadge status={a.status} />
                    </div>
                    <p className="line-clamp-2 text-xs text-ink-muted">{a.body}</p>
                    <UsedKnowledge refs={a.usedKnowledge} compact />
                    {a.decidedAt && (
                      <p className="text-2xs text-ink-subtle">
                        {deciderLabel(a)} · {formatRelative(a.decidedAt)}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </aside>
      </div>
    </Page>
  );
}

const STATE_LABEL: Record<MetricView["state"], string> = {
  running: "Running",
  paused: "Paused",
  achieved: "Met",
  breached: "Breached",
  not_applicable: "Not measured",
};

function MetricCard({ metric: m, warnAt, primary }: { metric: MetricView; warnAt: number[]; primary: boolean }) {
  const ended = m.state === "achieved";
  return (
    <Card className={cn("flex flex-col gap-3 p-4", primary && "border-line-strong shadow-sm md:col-span-2")}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="flex items-center gap-1 text-sm font-semibold text-ink">
            {METRIC_LABEL[m.metric]}
            {primary && <WhatsThis concept="thresholds" />}
          </h3>
          <p className="text-xs text-ink-muted">
            {STATE_LABEL[m.state]}
            {m.targetMs !== null && <> · target {formatDuration(m.targetMs)}</>}
            {m.breachCount > 0 && (
              <span className="text-breached-text">
                {" "}
                · {m.breachCount} breach{m.breachCount === 1 ? "" : "es"}
              </span>
            )}
          </p>
        </div>
        {!ended && <RiskBadge risk={m.risk} size="sm" />}
      </div>
      <SlaClock
        dueAt={m.dueAt}
        state={m.state}
        remainingMs={m.remainingMs}
        risk={m.risk === "ok" ? undefined : m.risk}
        size={primary ? "lg" : "md"}
      />
      <SlaBar
        label={`${METRIC_LABEL[m.metric]} target used`}
        elapsedMs={m.elapsedMs}
        targetMs={m.targetMs}
        warnAt={warnAt}
        risk={ended ? "ok" : m.risk}
        paused={m.state === "paused"}
        showScale
      />
      {m.dueAt && m.state === "running" && (
        <p className="text-xs text-ink-muted">
          Due <time dateTime={m.dueAt}>{formatDateTime(m.dueAt)}</time>
        </p>
      )}
      {m.state === "paused" && (
        <p className="text-xs text-ink-muted">The clock resumes when the ticket leaves a pause status.</p>
      )}
    </Card>
  );
}

function AgentRunRow({ run: r }: { run: AgentRun }) {
  const duration =
    r.startedAt && r.finishedAt ? new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime() : null;
  const kind = r.kind === "triage" ? "Triage" : r.kind === "draft_reply" ? "Draft reply" : "Contract extraction";
  return (
    <li className="flex items-start gap-3 border-b border-line px-5 py-3 last:border-b-0">
      <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-sunken text-ink-muted">
        <Bot className="size-3.5" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-ink">{kind}</span>
          <Badge size="sm" tone={r.status === "succeeded" ? "ok" : r.status === "failed" ? "breached" : "accent"}>
            {r.status}
          </Badge>
        </div>
        <p className="mt-0.5 font-mono text-2xs text-ink-muted tnum">
          {[
            r.model,
            formatMoney(r.costCents, "exact"),
            r.sandboxSeconds !== null ? `${r.sandboxSeconds.toFixed(1)}s sandbox` : null,
            duration !== null ? `${formatDuration(duration)} wall` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
        {r.startedAt && <p className="text-2xs text-ink-subtle">{formatRelative(r.startedAt)}</p>}
        {r.error && <p className="mt-1 text-xs text-breached-text">{r.error}</p>}
      </div>
    </li>
  );
}

function DraftCard({ action: a, ticketId }: { action: AgentAction; ticketId: string }) {
  const [body, setBody] = useState(a.body ?? "");
  const [rejecting, setRejecting] = useState(false);
  const queryClient = useQueryClient();
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["ticket", ticketId] });
    void queryClient.invalidateQueries({ queryKey: ["actions"] });
    void queryClient.invalidateQueries({ queryKey: ["tickets"] });
    void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  };
  const approve = useMutation({
    mutationFn: () => api.actions.approve(a.id, body !== a.body ? { body } : {}),
    onSuccess: () => {
      toast({ tone: "success", title: a.kind === "public_reply" ? "Reply sent" : "Note posted" });
      refresh();
    },
    onError: (e) => toast({ tone: "error", title: "Couldn't send the draft", description: errorMessage(e) }),
  });
  const reject = useMutation({
    mutationFn: (reason?: string) => api.actions.reject(a.id, reason ? { reason } : {}),
    onSuccess: () => {
      setRejecting(false);
      toast({ title: "Draft rejected", description: "Nothing was sent to the customer." });
      refresh();
    },
    onError: (e) => toast({ tone: "error", title: "Couldn't reject the draft", description: errorMessage(e) }),
  });
  const id = `draft-body-${a.id}`;
  return (
    <Card className={cn("overflow-hidden", a.status === "blocked" ? "border-warning-border" : "border-accent/30")}>
      <div className="flex flex-wrap items-center justify-between gap-2 px-5 pt-4">
        <div className="flex items-center gap-3">
          <ActionKindLabel kind={a.kind} />
          <ActionStatusBadge status={a.status} />
        </div>
        <div className="flex items-center gap-3">
          <ConfidenceMeter value={a.confidence} />
          <span className="text-2xs text-ink-subtle">{formatRelative(a.createdAt)}</span>
        </div>
      </div>
      <div className="flex flex-col gap-3 px-5 py-4">
        {a.status === "blocked" && a.blockedReason && (
          <div
            role="note"
            className="flex gap-2.5 rounded-md border border-warning-border bg-warning-subtle px-3 py-2.5 text-sm text-warning-text"
          >
            <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            <p>
              <span className="font-semibold">Autopilot held this draft. </span>
              {a.blockedReason}
            </p>
          </div>
        )}
        <Label htmlFor={id} className="sr-only">
          Draft body
        </Label>
        <Textarea id={id} value={body} onChange={(e) => setBody(e.target.value)} rows={7} />
        {a.kind === "public_reply" && <UsedKnowledge refs={a.usedKnowledge} />}
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-line bg-sunken/40 px-5 py-3">
        {body !== (a.body ?? "") && (
          <Button variant="ghost" size="sm" onClick={() => setBody(a.body ?? "")}>
            Discard edits
          </Button>
        )}
        <Button size="sm" onClick={() => setRejecting(true)} disabled={approve.isPending}>
          Reject…
        </Button>
        <Button
          size="sm"
          variant="primary"
          loading={approve.isPending}
          disabled={!body.trim() || reject.isPending}
          onClick={() => approve.mutate()}
        >
          {a.kind === "public_reply" ? "Approve & send" : "Approve & post"}
        </Button>
      </div>
      <RejectDialog
        open={rejecting}
        onOpenChange={setRejecting}
        loading={reject.isPending}
        onConfirm={(reason) => reject.mutate(reason)}
      />
    </Card>
  );
}

function DetailSkeleton() {
  return (
    <Page docTitle="Ticket" width="wide">
      <div role="status" aria-live="polite" className="flex flex-col gap-5">
        <span className="sr-only">Loading ticket…</span>
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-8 w-2/3" />
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
          <div className="flex flex-col gap-3">
            <Skeleton className="h-40 w-full rounded-lg" />
            <div className="grid grid-cols-2 gap-3">
              <Skeleton className="h-32 rounded-lg" />
              <Skeleton className="h-32 rounded-lg" />
            </div>
            <Skeleton className="h-72 w-full rounded-lg" />
          </div>
          <Skeleton className="h-64 w-full rounded-lg" />
        </div>
      </div>
    </Page>
  );
}
