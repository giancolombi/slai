import type { AgentAction } from "@slai/shared";
import { Card, RiskBadge, Skeleton, SkeletonRows, SlaClock, toast } from "@slai/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { ErrorState, Page } from "../../components/page";
import { useAccess } from "../../lib/access";
import { api, errorMessage } from "../../lib/api";
import { METRIC_LABEL, PRIORITY_LABEL } from "../../lib/labels";
import { useActions, useTicket } from "../../lib/queries";
import { ApprovalsInbox } from "./inbox";

export function ApprovalsPage() {
  const proposed = useActions("proposed");
  const blocked = useActions("blocked");
  const { canWork } = useAccess();
  const queryClient = useQueryClient();
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [pendingId, setPendingId] = useState<string | null>(null);

  const items = useMemo(
    () =>
      [...(proposed.data?.items ?? []), ...(blocked.data?.items ?? [])]
        .filter((a) => !hidden.has(a.id))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [proposed.data, blocked.data, hidden],
  );

  const hide = (id: string) => setHidden((s) => new Set(s).add(id));
  const unhide = (id: string) =>
    setHidden((s) => {
      const next = new Set(s);
      next.delete(id);
      return next;
    });
  const refresh = (ticketId: string) => {
    void queryClient.invalidateQueries({ queryKey: ["actions"] });
    void queryClient.invalidateQueries({ queryKey: ["ticket", ticketId] });
    void queryClient.invalidateQueries({ queryKey: ["tickets"] });
    void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  };

  const approve = useMutation({
    mutationFn: ({ item, body }: { item: AgentAction; body: string }) =>
      api.actions.approve(item.id, body !== item.body ? { body } : {}),
    onMutate: ({ item }) => {
      setPendingId(item.id);
      hide(item.id);
    },
    onSuccess: (_res, { item }) => {
      toast({
        tone: "success",
        title:
          item.kind === "public_reply"
            ? `Reply sent on ${item.ticketKey}`
            : item.kind === "internal_note"
              ? `Note posted on ${item.ticketKey}`
              : `Change applied on ${item.ticketKey}`,
        description: item.ticketSubject,
      });
      refresh(item.ticketId);
    },
    onError: (e, { item }) => {
      unhide(item.id);
      toast({ tone: "error", title: `Couldn't send the draft for ${item.ticketKey}`, description: errorMessage(e) });
    },
    onSettled: () => setPendingId(null),
  });

  const reject = useMutation({
    mutationFn: ({ item, reason }: { item: AgentAction; reason?: string }) =>
      api.actions.reject(item.id, reason ? { reason } : {}),
    onMutate: ({ item }) => {
      setPendingId(item.id);
      hide(item.id);
    },
    onSuccess: (_res, { item }) => {
      toast({ title: `Draft rejected for ${item.ticketKey}`, description: "Nothing was sent to the customer." });
      refresh(item.ticketId);
    },
    onError: (e, { item }) => {
      unhide(item.id);
      toast({ tone: "error", title: `Couldn't reject the draft for ${item.ticketKey}`, description: errorMessage(e) });
    },
    onSettled: () => setPendingId(null),
  });

  const loading = proposed.isPending || blocked.isPending;
  const error = proposed.error ?? blocked.error;

  return (
    <Page
      title="Approvals"
      description="Drafts written by agents under assist rules, and autopilot drafts a guardrail held back. Nothing reaches a customer until you approve it."
      width="wide"
    >
      {loading ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-[minmax(260px,340px)_minmax(0,1fr)]">
          <Card className="p-4">
            <SkeletonRows rows={6} label="Loading drafts" />
          </Card>
          <Card className="flex flex-col gap-3 p-5">
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-48 w-full" />
          </Card>
        </div>
      ) : error ? (
        <Card>
          <ErrorState
            error={error}
            resource="drafts"
            onRetry={() => {
              void proposed.refetch();
              void blocked.refetch();
            }}
          />
        </Card>
      ) : (
        <ApprovalsInbox
          items={items}
          pendingId={pendingId}
          readOnly={!canWork}
          onApprove={(item, body) => approve.mutate({ item, body })}
          onReject={(item, reason) => reject.mutate({ item, reason })}
          renderContext={(item) => <TicketContext ticketId={item.ticketId} />}
          renderTicketLink={(item, children) => (
            <Link to="/tickets/$ticketId" params={{ ticketId: item.ticketId }} className="hover:underline">
              {children}
            </Link>
          )}
        />
      )}
    </Page>
  );
}

/** Live SLA context for the ticket a draft belongs to. */
function TicketContext({ ticketId }: { ticketId: string }) {
  const ticket = useTicket(ticketId);
  if (ticket.isPending) return <Skeleton className="h-14 w-full rounded-md" />;
  if (ticket.isError) return null;
  const t = ticket.data;
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-md border border-line bg-sunken/50 px-3.5 py-2.5">
      <RiskBadge risk={t.risk} size="sm" />
      {t.next ? (
        <div className="flex items-baseline gap-2">
          <span className="text-xs text-ink-muted">{METRIC_LABEL[t.next.metric]}</span>
          <SlaClock
            dueAt={t.next.dueAt}
            state={t.next.state}
            remainingMs={t.next.remainingMs}
            risk={t.risk === "ok" ? undefined : t.risk}
            size="md"
          />
        </div>
      ) : (
        <span className="text-xs text-ink-muted">No live clock</span>
      )}
      <span className="text-xs text-ink-muted">
        {[t.customer?.name, t.priority ? PRIORITY_LABEL[t.priority] : null, t.requester.name]
          .filter(Boolean)
          .join(" · ")}
      </span>
    </div>
  );
}
