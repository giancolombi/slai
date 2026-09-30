import type { Risk, TicketStatus, TicketSummary } from "@slai/shared";
import {
  Avatar,
  Button,
  Card,
  EmptyState,
  formatRelative,
  Input,
  RISK_META,
  RiskBadge,
  SegmentedControl,
  Select,
  SkeletonRows,
  SlaClock,
  Table,
  TableMessage,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from "@slai/ui";
import { useInfiniteQuery } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { Inbox, Search, SearchX } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ErrorState, Page } from "../../components/page";
import { GuideButton } from "../../help/guide-button";
import { WhatsThis } from "../../help/whats-this";
import { api, type TicketQuery } from "../../lib/api";
import { METRIC_LABEL, providerLabel, STATUS_LABEL, STATUSES } from "../../lib/labels";
import { useCustomers } from "../../lib/queries";
import { PriorityBadge } from "./priority-badge";

const route = getRouteApi("/_app/tickets");

const RISK_OPTIONS: { value: Risk | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "breached", label: "Breached" },
  { value: "at_risk", label: "At risk" },
  { value: "warning", label: "Warning" },
  { value: "ok", label: "On track" },
];

export function TicketsPage() {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const customers = useCustomers();
  const [text, setText] = useState(search.q ?? "");

  // Keep the box in sync when the URL changes elsewhere (e.g. the global search).
  useEffect(() => setText(search.q ?? ""), [search.q]);

  // Debounce typing into the URL.
  useEffect(() => {
    const q = text.trim() || undefined;
    if (q === search.q) return;
    const t = setTimeout(() => navigate({ search: (prev) => ({ ...prev, q }), replace: true }), 300);
    return () => clearTimeout(t);
  }, [text, search.q, navigate]);

  const filters: TicketQuery = {
    risk: search.risk,
    status: search.status,
    customerId: search.customerId,
    q: search.q,
  };
  const query = useInfiniteQuery({
    queryKey: ["tickets", "list", filters],
    queryFn: ({ pageParam, signal }) => api.tickets.list({ ...filters, cursor: pageParam }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    refetchInterval: 30_000,
    placeholderData: (prev) => prev,
  });
  const tickets = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);
  const filtered = Boolean(search.risk || search.status || search.customerId || search.q);
  const clear = () => {
    setText("");
    navigate({ search: {} });
  };

  const customerOptions = [
    { value: "all", label: "All customers" },
    ...(customers.data?.items ?? []).map((c) => ({ value: c.id, label: c.name })),
  ];

  return (
    <Page title="Tickets" description="Every ticket on its contract's clock, most urgent first." width="wide">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <SegmentedControl
          aria-label="Filter by risk"
          value={search.risk ?? "all"}
          onValueChange={(v) =>
            navigate({ search: (prev) => ({ ...prev, risk: v === "all" ? undefined : (v as Risk) }) })
          }
          options={RISK_OPTIONS.map((o) => ({
            value: o.value,
            label:
              o.value === "all" ? (
                o.label
              ) : (
                <>
                  <RiskIcon risk={o.value} />
                  {o.label}
                </>
              ),
            ariaLabel: o.label,
          }))}
        />
        <div className="w-40">
          <Select
            aria-label="Filter by status"
            value={search.status ?? "all"}
            onValueChange={(v) =>
              navigate({ search: (prev) => ({ ...prev, status: v === "all" ? undefined : (v as TicketStatus) }) })
            }
            options={[
              { value: "all", label: "All statuses" },
              ...STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] })),
            ]}
          />
        </div>
        <div className="w-52">
          <Select
            aria-label="Filter by customer"
            value={search.customerId ?? "all"}
            onValueChange={(v) =>
              navigate({ search: (prev) => ({ ...prev, customerId: v === "all" ? undefined : v }) })
            }
            options={customerOptions}
          />
        </div>
        <div className="ml-auto w-full sm:w-64">
          <label htmlFor="ticket-filter-q" className="sr-only">
            Search subject, key or customer
          </label>
          <Input
            id="ticket-filter-q"
            type="search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Subject, key or customer"
            leading={<Search />}
          />
        </div>
      </div>

      <Card className="overflow-hidden">
        <Table aria-label="Tickets" aria-busy={query.isFetching || undefined} maxHeight="calc(100dvh - 260px)">
          <THead>
            <tr>
              <TH>Ticket</TH>
              <TH className="hidden md:table-cell">Customer</TH>
              <TH className="hidden lg:table-cell">Priority</TH>
              <TH className="hidden lg:table-cell">Status</TH>
              <TH>
                <span className="inline-flex items-center gap-1">
                  Risk <WhatsThis concept="risk" />
                </span>
              </TH>
              <TH aria-sort="ascending">Next due</TH>
              <TH className="hidden xl:table-cell">Assignee</TH>
            </tr>
          </THead>
          <TBody>
            {query.isPending ? (
              <TableMessage colSpan={7}>
                <SkeletonRows rows={10} className="p-4" label="Loading tickets" />
              </TableMessage>
            ) : query.isError ? (
              <TableMessage colSpan={7}>
                <ErrorState error={query.error} resource="tickets" onRetry={() => query.refetch()} />
              </TableMessage>
            ) : tickets.length === 0 ? (
              <TableMessage colSpan={7}>
                {filtered ? (
                  <EmptyState
                    icon={<SearchX />}
                    title="No tickets match these filters"
                    description="Try a different risk or status, or clear the filters."
                    action={
                      <Button size="sm" onClick={clear}>
                        Clear filters
                      </Button>
                    }
                  />
                ) : (
                  <EmptyState
                    icon={<Inbox />}
                    title="No tickets yet"
                    description="Tickets appear here once a help desk is connected and synced."
                    action={
                      <>
                        <Button asChild size="sm" variant="primary">
                          <Link to="/connections">Connect a help desk</Link>
                        </Button>
                        <GuideButton guide="sla-clock" />
                      </>
                    }
                  />
                )}
              </TableMessage>
            ) : (
              tickets.map((t) => <TicketRow key={t.id} ticket={t} />)
            )}
          </TBody>
        </Table>
        {query.hasNextPage && (
          <div className="flex items-center justify-center border-t border-line p-3">
            <Button size="sm" loading={query.isFetchingNextPage} onClick={() => query.fetchNextPage()}>
              Load more
            </Button>
          </div>
        )}
      </Card>
      {tickets.length > 0 && (
        <p className="mt-3 text-xs text-ink-muted" aria-live="polite">
          Showing {tickets.length} ticket{tickets.length === 1 ? "" : "s"}
          {query.hasNextPage ? " (more available)" : ""}. Sorted by next due time; paused clocks last.
        </p>
      )}
    </Page>
  );
}

function RiskIcon({ risk }: { risk: Risk }) {
  const Icon = RISK_META[risk].icon;
  return <Icon className={RISK_META[risk].text} aria-hidden />;
}

function TicketRow({ ticket: t }: { ticket: TicketSummary }) {
  const navigate = useNavigate();
  return (
    <TR
      interactive
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("a, button")) return;
        navigate({ to: "/tickets/$ticketId", params: { ticketId: t.id } });
      }}
    >
      <TD className="max-w-0 w-[40%]">
        <div className="flex min-w-0 flex-col">
          <Link
            to="/tickets/$ticketId"
            params={{ ticketId: t.id }}
            className="truncate font-medium text-ink hover:underline"
          >
            {t.subject}
          </Link>
          <span className="truncate text-xs text-ink-muted">
            <span className="font-mono">{t.displayKey}</span> · {providerLabel(t.provider)} · updated{" "}
            {formatRelative(t.updatedAt)}
          </span>
        </div>
      </TD>
      <TD className="hidden md:table-cell">
        <span className="text-sm text-ink">
          {t.customer?.name ?? <span className="text-ink-subtle">Unmatched</span>}
        </span>
      </TD>
      <TD className="hidden lg:table-cell">
        {t.priority ? <PriorityBadge priority={t.priority} /> : <span className="text-ink-subtle">—</span>}
      </TD>
      <TD className="hidden lg:table-cell text-sm text-ink-muted">{STATUS_LABEL[t.status]}</TD>
      <TD>
        <RiskBadge risk={t.risk} size="sm" />
      </TD>
      <TD>
        {t.next ? (
          <div className="flex flex-col">
            <SlaClock
              dueAt={t.next.dueAt}
              state={t.next.state}
              remainingMs={t.next.remainingMs}
              risk={t.risk === "ok" ? undefined : t.risk}
              size="sm"
            />
            <span className="text-2xs text-ink-muted">{METRIC_LABEL[t.next.metric]}</span>
          </div>
        ) : (
          <span className="text-xs text-ink-subtle">No live clock</span>
        )}
      </TD>
      <TD className="hidden xl:table-cell">
        {t.assigneeName ? (
          <span className="inline-flex items-center gap-2 text-sm text-ink">
            <Avatar name={t.assigneeName} size="xs" />
            <span className="truncate">{t.assigneeName}</span>
          </span>
        ) : (
          <span className="text-xs text-ink-subtle">Unassigned</span>
        )}
      </TD>
    </TR>
  );
}
