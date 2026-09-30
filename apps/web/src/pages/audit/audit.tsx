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

/** Every audit action as a plain sentence fragment. The raw codes stay in the API and the export. */
const ACTION_LABELS: Record<string, string> = {
  "auth.signup": "Created the organization",
  "auth.login": "Signed in",
  "auth.logout": "Signed out",
  "auth.login_failed": "Failed sign-in attempt",
  "auth.login_rate_limited": "Sign-in blocked after too many attempts",
  "auth.password_verified": "Confirmed their password",
  "auth.mfa_setup_started": "Started setting up two-factor",
  "auth.mfa_enabled": "Turned on two-factor",
  "auth.mfa_disabled": "Turned off two-factor",
  "auth.mfa_verified": "Verified two-factor",
  "auth.mfa_failed": "Entered a wrong two-factor code",
  "auth.mfa_break_glass_reset": "Two-factor reset by slai support",
  "auth.backup_code_used": "Signed in with a backup code",
  "auth.backup_codes_regenerated": "Made new backup codes",
  "auth.passkey_added": "Added a passkey",
  "auth.passkey_removed": "Removed a passkey",
  "auth.step_up": "Confirmed their identity for a sensitive change",
  "auth.step_up_failed": "Failed to confirm their identity",
  "auth.org_switched": "Switched organization",
  "agent.requested": "Asked an agent to work a ticket",
  "action.approved": "Approved a draft",
  "action.rejected": "Rejected a draft",
  "action.sent": "Sent a reply to the help desk",
  "action.failed": "Couldn't send a draft to the help desk",
  "action.blocked": "Autopilot held a draft for review",
  "notification.sent": "Sent a notification",
  "connection.created": "Connected a help desk",
  "connection.deleted": "Removed a connection",
  "connection.tested": "Tested a connection",
  "connection.error": "A connection stopped syncing",
  "connection.sync_failed": "Help desk sync failed",
  "connection.mapping_updated": "Changed a status and priority mapping",
  "connection.webhook_secret_set": "Saved a webhook secret",
  "connection.webhook_secret_revealed": "Viewed a webhook secret",
  "contract.uploaded": "Uploaded a contract",
  "contract.extracted": "Read a contract's SLA terms",
  "contract.archived": "Archived a contract",
  "contract.downloaded": "Downloaded a contract",
  "contract.text_viewed": "Viewed a contract's text",
  "contract.purged": "Deleted a contract file",
  "policy.created": "Created a policy",
  "policy.updated": "Edited a policy",
  "policy.approved": "Approved a policy",
  "policy.archived": "Archived a policy",
  "policy.default_changed": "Changed the default policy",
  "customer.created": "Added a customer",
  "customer.updated": "Updated a customer",
  "customer.deleted": "Removed a customer",
  "autonomy.created": "Added an autonomy rule",
  "autonomy.updated": "Changed an autonomy rule",
  "autonomy.deleted": "Removed an autonomy rule",
  "knowledge_source.created": "Added a knowledge source",
  "knowledge_source.sync_requested": "Synced a knowledge source",
  "saved_reply.created": "Added a saved reply",
  "saved_reply.updated": "Edited a saved reply",
  "saved_reply.deleted": "Removed a saved reply",
  "notification_channel.created": "Added an alert channel",
  "notification_channel.updated": "Changed an alert channel",
  "notification_channel.deleted": "Removed an alert channel",
  "member.invited": "Invited a member",
  "member.invitation_resent": "Resent an invitation",
  "member.invitation_revoked": "Revoked an invitation",
  "member.invitation_accepted": "Accepted an invitation",
  "member.role_changed": "Changed a member's role",
  "member.removed": "Removed a member",
  "member.mfa_reset": "Reset a member's two-factor",
  "replay.requested": "Started a Breach Replay",
  "replay.started": "Started a Breach Replay",
  "replay.completed": "Breach Replay finished",
  "org.updated": "Updated organization settings",
  "org.export.requested": "Requested a data export",
  "org.export.completed": "Data export ready",
  "org.export.downloaded": "Downloaded a data export",
  "org.deletion.scheduled": "Scheduled the organization for deletion",
  "org.deletion.cancelled": "Cancelled the organization's deletion",
  "org.deleted": "Deleted the organization",
  "retention.purged": "Removed data past its retention period",
  "sso.provider_created": "Added a single sign-on provider",
  "sso.provider_updated": "Changed a single sign-on provider",
  "sso.provider_deleted": "Removed a single sign-on provider",
  "sso.domain_verified": "Verified a sign-on domain",
  "sso.domain_verification_failed": "Couldn't verify a sign-on domain",
  "sso.enforcement_enabled": "Required single sign-on",
  "sso.enforcement_disabled": "Stopped requiring single sign-on",
  "sso.mfa_policy_changed": "Changed two-factor rules for single sign-on",
  "sso.idp_mfa_policy_changed": "Changed the identity provider two-factor rule",
  "sso.jit_provisioned": "Joined through single sign-on",
  "scim.token_created": "Created a provisioning token",
  "scim.token_revoked": "Revoked a provisioning token",
  "scim.group_role_mapped": "Mapped an identity provider group to a role",
  "scim.group_role_unmapped": "Removed a group-to-role mapping",
  "billing.checkout_started": "Started checkout",
  "billing.credit_pack_checkout_started": "Started buying credits",
  "billing.customer_created": "Set up billing",
  "billing.manual_update": "Changed the plan",
  "billing.trial_ending": "Trial ending soon",
  "billing.trial_expired": "Trial ended",
  "billing.degraded": "Agents limited to observe after a missed payment",
  "billing.tracked_overage": "Went over the tracked-ticket limit",
  "billing.period_closed": "Closed a billing period",
  "billing.usage_reported": "Reported usage for billing",
  "usage.cap_threshold": "Credits reached a spend-cap alert",
};

const sentence = (s: string) =>
  s
    .replace(/[_.]+/g, " ")
    .trim()
    .replace(/^\w/, (c) => c.toUpperCase());

/** A human label for any action, including ones added after this list: never the raw code. */
export function actionLabel(action: string) {
  if (ACTION_LABELS[action]) return ACTION_LABELS[action];
  const parts = action.split(".");
  const verb = parts.pop() ?? action;
  return `${sentence(verb)}${parts.length ? ` (${parts.map((p) => p.replace(/_/g, " ")).join(" ")})` : ""}`;
}

const TARGET_LABELS: Record<string, string> = {
  agent_action: "Draft",
  agent_run: "Agent work",
  autonomy_rule: "Autonomy rule",
  billing_period: "Billing period",
  customer_account: "Customer",
  invitation: "Invitation",
  knowledge_article: "Knowledge article",
  knowledge_source: "Knowledge source",
  notification_channel: "Alert channel",
  org_export: "Data export",
  organization: "Organization",
  scim_group_role: "Group mapping",
  scim_group: "Identity provider group",
  scim_token: "Provisioning token",
  sso_provider: "Single sign-on provider",
  user: "Person",
};

export function targetLabel(type: string) {
  return TARGET_LABELS[type] ?? sentence(type);
}

/** Metadata as labelled values ("Email: …"), not JSON. */
function metadataEntries(m: unknown): [string, string][] {
  if (!m || typeof m !== "object") return [];
  return Object.entries(m as Record<string, unknown>)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => [
      sentence(k.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()),
      typeof v === "object" ? JSON.stringify(v) : String(v),
    ]);
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
  return metadataEntries(m).length > 0;
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
        actionLabel(e.action),
        e.actor.name ?? "",
        targetLabel(e.target.type),
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
      description="A permanent record of sign-ins, approvals, policy and autonomy changes, and everything slai changed in your help desk."
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
              placeholder="Filter by action, person or IP"
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
                        </TD>
                        <TD className="hidden md:table-cell">
                          <span className="text-ink-muted">{targetLabel(e.target.type)}</span>
                        </TD>
                        <TD className="hidden font-mono text-xs text-ink-muted lg:table-cell">{e.ip ?? "—"}</TD>
                      </TR>
                      {isOpen && (
                        <tr>
                          <td colSpan={6} className="border-b border-line bg-sunken/50 px-4 py-3">
                            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                              {metadataEntries(e.metadata).map(([k, v]) => (
                                <Fragment key={k}>
                                  <dt className="text-ink-muted">{k}</dt>
                                  <dd className="min-w-0 break-words text-ink">{v}</dd>
                                </Fragment>
                              ))}
                            </dl>
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
