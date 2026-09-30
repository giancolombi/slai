import type { AuditEvent } from "@slai/shared";
import {
  Avatar,
  Button,
  Card,
  EmptyState,
  formatDateTime,
  formatRelative,
  IconButton,
  Input,
  SegmentedControl,
  SkeletonRows,
  Table,
  TableMessage,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from "@slai/ui";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Bot, ChevronDown, ChevronRight, Cpu, Search, ShieldCheck } from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import { ErrorState, Page } from "../../components/page";
import { GuideButton } from "../../help/guide-button";
import { api } from "../../lib/api";
import { qk } from "../../lib/queries";

type ActorFilter = "all" | AuditEvent["actor"]["type"];

const ACTION_LABELS: Record<string, string> = {
  "auth.login": "Signed in",
  "auth.signup": "Created the organization",
  "auth.mfa_enabled": "Turned on two-factor",
  "action.approved": "Approved a draft",
  "action.rejected": "Rejected a draft",
  "action.sent": "Sent a reply",
  "connection.created": "Connected a help desk",
  "connection.deleted": "Removed a connection",
  "connection.sync_failed": "Help desk sync failed",
  "policy.approved": "Approved a policy",
  "policy.archived": "Archived a policy",
  "policy.default_changed": "Changed the default policy",
  "autonomy.created": "Added an autonomy rule",
  "autonomy.updated": "Changed an autonomy rule",
  "autonomy.deleted": "Removed an autonomy rule",
  "member.invited": "Invited a member",
  "member.role_changed": "Changed a member's role",
  "member.removed": "Removed a member",
  "contract.uploaded": "Uploaded a contract",
  "contract.extracted": "Extracted a contract",
  "replay.started": "Started a Breach Replay",
  "replay.completed": "Breach Replay finished",
  "org.updated": "Updated organization settings",
  "customer.created": "Added a customer",
  "customer.updated": "Updated a customer",
  "notification_channel.created": "Added a notification channel",
};

export function actionLabel(action: string) {
  return (
    ACTION_LABELS[action] ??
    action
      .split(".")
      .reverse()
      .join(" ")
      .replace(/_/g, " ")
      .replace(/^\w/, (c) => c.toUpperCase())
  );
}

function Actor({ actor }: { actor: AuditEvent["actor"] }) {
  if (actor.type === "user") {
    return (
      <span className="flex items-center gap-2">
        <Avatar name={actor.name} size="xs" />
        <span className="truncate text-ink">{actor.name ?? "Unknown user"}</span>
      </span>
    );
  }
  const Icon = actor.type === "agent" ? Bot : Cpu;
  return (
    <span className="flex items-center gap-2">
      <span className="inline-flex size-5 items-center justify-center rounded-full border border-line bg-sunken text-ink-muted">
        <Icon className="size-3" aria-hidden />
      </span>
      <span className="truncate text-ink-muted">
        {actor.name ?? (actor.type === "system" ? "slai system" : "Agent")}
      </span>
    </span>
  );
}

function hasMetadata(m: unknown) {
  return m !== null && typeof m === "object" && Object.keys(m as object).length > 0;
}

export function AuditPage() {
  const [actor, setActor] = useState<ActorFilter>("all");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());

  const query = useInfiniteQuery({
    queryKey: qk.audit,
    queryFn: ({ pageParam }) => api.audit.list(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });

  const all = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);
  const rows = useMemo(() => {
    const text = q.trim().toLowerCase();
    return all.filter((e) => {
      if (actor !== "all" && e.actor.type !== actor) return false;
      if (!text) return true;
      return [
        e.action,
        actionLabel(e.action),
        e.actor.name ?? "",
        e.target.type,
        e.target.id ?? "",
        e.ip ?? "",
        JSON.stringify(e.metadata),
      ]
        .join(" ")
        .toLowerCase()
        .includes(text);
    });
  }, [all, actor, q]);

  const toggle = (id: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Page
      title="Audit log"
      description="Append-only record of sign-ins, approvals, policy and autonomy changes, and every write to your help desk."
      width="wide"
    >
      {query.isError ? (
        <Card>
          <ErrorState error={query.error} resource="the audit log" onRetry={() => query.refetch()} />
        </Card>
      ) : (
        <Card>
          <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
            <SegmentedControl
              aria-label="Actor type"
              size="sm"
              value={actor}
              onValueChange={(v) => setActor(v as ActorFilter)}
              options={[
                { value: "all", label: "All" },
                { value: "user", label: "People" },
                { value: "agent", label: "Agents" },
                { value: "system", label: "System" },
              ]}
            />
            <Input
              type="search"
              inputSize="sm"
              aria-label="Filter events"
              placeholder="Filter by action, person, target or IP"
              leading={<Search />}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="w-full max-w-xs"
            />
            <span className="ml-auto text-xs text-ink-muted" aria-live="polite">
              {query.isPending ? "" : `${rows.length} of ${all.length} loaded events`}
            </span>
          </div>
          <Table aria-label="Audit events" maxHeight="calc(100dvh - 300px)" dense>
            <THead>
              <tr>
                <TH className="w-8">
                  <span className="sr-only">Details</span>
                </TH>
                <TH>Time</TH>
                <TH>Actor</TH>
                <TH>Action</TH>
                <TH className="hidden md:table-cell">Target</TH>
                <TH className="hidden lg:table-cell">IP</TH>
              </tr>
            </THead>
            <TBody>
              {query.isPending ? (
                <TableMessage colSpan={6}>
                  <SkeletonRows rows={10} className="p-4" label="Loading audit events" />
                </TableMessage>
              ) : rows.length === 0 ? (
                <TableMessage colSpan={6}>
                  <EmptyState
                    icon={<ShieldCheck />}
                    title={all.length === 0 ? "No events yet" : "No events match"}
                    description={
                      all.length === 0
                        ? "Sign-ins, approvals, policy and autonomy changes, and every help-desk write are recorded here."
                        : "Try another filter, or load older events."
                    }
                    action={all.length === 0 ? <GuideButton guide="team-security" anchor="audit" /> : undefined}
                  />
                </TableMessage>
              ) : (
                rows.map((e) => {
                  const expandable = hasMetadata(e.metadata);
                  const isOpen = open.has(e.id);
                  return (
                    <Fragment key={e.id}>
                      <TR>
                        <TD className="pr-0">
                          {expandable && (
                            <IconButton
                              size="sm"
                              label={isOpen ? "Hide details" : "Show details"}
                              aria-expanded={isOpen}
                              icon={isOpen ? <ChevronDown /> : <ChevronRight />}
                              onClick={() => toggle(e.id)}
                            />
                          )}
                        </TD>
                        <TD className="whitespace-nowrap">
                          <time
                            dateTime={e.at}
                            title={new Date(e.at).toISOString()}
                            className="font-mono text-xs text-ink-muted tnum"
                          >
                            {formatDateTime(e.at)}
                          </time>
                          <div className="text-2xs text-ink-subtle">{formatRelative(e.at)}</div>
                        </TD>
                        <TD className="max-w-48">
                          <Actor actor={e.actor} />
                        </TD>
                        <TD>
                          <div className="text-ink">{actionLabel(e.action)}</div>
                          <code className="font-mono text-2xs text-ink-subtle">{e.action}</code>
                        </TD>
                        <TD className="hidden md:table-cell">
                          <span className="text-ink-muted">{e.target.type.replace(/_/g, " ")}</span>
                          {e.target.id && (
                            <code className="ml-1.5 font-mono text-2xs text-ink-subtle">{e.target.id}</code>
                          )}
                        </TD>
                        <TD className="hidden font-mono text-xs text-ink-muted lg:table-cell">{e.ip ?? "—"}</TD>
                      </TR>
                      {isOpen && (
                        <tr>
                          <td colSpan={6} className="border-b border-line bg-sunken/50 px-4 py-3">
                            <pre className="overflow-x-auto font-mono text-xs leading-relaxed text-ink scrollbar-thin">
                              {JSON.stringify(e.metadata, null, 2)}
                            </pre>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })
              )}
            </TBody>
          </Table>
          {query.hasNextPage && (
            <div className="flex justify-center border-t border-line p-3">
              <Button
                size="sm"
                variant="secondary"
                loading={query.isFetchingNextPage}
                onClick={() => query.fetchNextPage()}
              >
                Load older events
              </Button>
            </div>
          )}
        </Card>
      )}
    </Page>
  );
}
