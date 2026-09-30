import type { Connection } from "@slai/shared";
import {
  Badge,
  type BadgeTone,
  Button,
  Card,
  Dialog,
  EmptyState,
  formatNumber,
  formatRelative,
  IconButton,
  Sheet,
  Skeleton,
  Tooltip,
  toast,
} from "@slai/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import {
  Cable,
  CircleAlert,
  CircleCheck,
  CirclePause,
  Copy,
  PlugZap,
  Plus,
  RefreshCw,
  Shuffle,
  Trash2,
  Webhook,
  X,
} from "lucide-react";
import { useState } from "react";
import { Page, QueryState } from "../../components/page";
import { api, errorMessage } from "../../lib/api";
import { providerLabel } from "../../lib/labels";
import { qk, useConnections, useMe } from "../../lib/queries";
import { ConnectHelpDesk } from "./connector-form";
import { ProviderMark } from "./provider-mark";

export const CONNECTION_STATUS: Record<
  Connection["status"],
  { label: string; tone: BadgeTone; icon: React.ReactNode }
> = {
  active: { label: "Active", tone: "ok", icon: <CircleCheck aria-hidden /> },
  error: { label: "Error", tone: "breached", icon: <CircleAlert aria-hidden /> },
  paused: { label: "Paused", tone: "neutral", icon: <CirclePause aria-hidden /> },
};

export async function copyText(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast({ tone: "success", title: `${what} copied` });
  } catch {
    toast({
      tone: "error",
      title: `Couldn't copy ${what.toLowerCase()}`,
      description: "Select the text and copy it manually.",
    });
  }
}

function ConnectionCard({ connection, canManage }: { connection: Connection; canManage: boolean }) {
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const status = CONNECTION_STATUS[connection.status];

  const test = useMutation({
    mutationFn: () => api.connections.test(connection.id),
    onSuccess: (r) =>
      toast({ tone: "success", title: "Connection works", description: `Signed in as ${r.accountName}.` }),
    onError: (e) => toast({ tone: "error", title: "Connection test failed", description: errorMessage(e) }),
  });
  const sync = useMutation({
    mutationFn: () => api.connections.sync(connection.id),
    onSuccess: () => {
      toast({ tone: "info", title: "Sync started", description: "New and changed tickets will appear in a minute." });
      queryClient.invalidateQueries({ queryKey: qk.connections });
    },
    onError: (e) => toast({ tone: "error", title: "Couldn't start a sync", description: errorMessage(e) }),
  });
  const remove = useMutation({
    mutationFn: () => api.connections.remove(connection.id),
    onSuccess: () => {
      setConfirm(false);
      toast({ tone: "success", title: `${connection.name} removed` });
      queryClient.invalidateQueries({ queryKey: qk.connections });
    },
    onError: (e) => toast({ tone: "error", title: "Couldn't remove the connection", description: errorMessage(e) }),
  });

  return (
    <Card className="flex flex-col">
      <div className="flex items-start gap-3 px-5 pt-5">
        <ProviderMark provider={connection.provider} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-md font-semibold text-ink">
              <Link
                to="/connections/$connectionId"
                params={{ connectionId: connection.id }}
                search={{}}
                className="hover:underline"
              >
                {connection.name}
              </Link>
            </h2>
            <Badge tone={status.tone} size="sm" icon={status.icon}>
              {status.label}
            </Badge>
          </div>
          <p className="text-xs text-ink-muted">{providerLabel(connection.provider)}</p>
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 px-5 py-4 text-sm">
        <div>
          <dt className="text-xs text-ink-muted">Tickets tracked</dt>
          <dd className="font-mono text-ink tnum">{formatNumber(connection.ticketCount)}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-muted">Last sync</dt>
          <dd className="text-ink">
            {connection.lastSyncAt ? (
              <time dateTime={connection.lastSyncAt}>{formatRelative(connection.lastSyncAt)}</time>
            ) : (
              "Never"
            )}
          </dd>
        </div>
        <div className="col-span-2">
          <dt className="flex items-center gap-1 text-xs text-ink-muted">
            <Webhook className="size-3" aria-hidden /> Webhook URL
          </dt>
          <dd className="mt-1 flex items-center gap-1">
            {connection.webhookUrl ? (
              <>
                <code className="min-w-0 flex-1 truncate rounded-sm border border-line bg-sunken px-2 py-1 font-mono text-2xs text-ink-muted">
                  {connection.webhookUrl}
                </code>
                <IconButton
                  size="sm"
                  label="Copy webhook URL"
                  icon={<Copy />}
                  onClick={() => copyText(connection.webhookUrl!, "Webhook URL")}
                />
              </>
            ) : (
              <span className="text-xs text-ink-muted">Polling only (no webhooks for this help desk)</span>
            )}
          </dd>
        </div>
      </dl>

      {connection.mappingIssues.length > 0 && (
        <Link
          to="/connections/$connectionId"
          params={{ connectionId: connection.id }}
          search={{}}
          className="mx-5 mb-4 flex items-start gap-2 rounded-md border border-warning-border bg-warning-subtle px-3 py-2 text-sm text-warning-text hover:underline"
        >
          <Shuffle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            {connection.mappingIssues.length === 1
              ? "1 unmapped status or priority"
              : `${connection.mappingIssues.length} unmapped statuses or priorities`}
            . Map them
          </span>
        </Link>
      )}

      {connection.status === "error" && connection.lastError && (
        <div
          role="alert"
          className="mx-5 mb-4 flex items-start gap-2 rounded-md border border-breached-border bg-breached-subtle px-3 py-2 text-sm text-breached-text"
        >
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>{connection.lastError}</span>
        </div>
      )}

      <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-line px-5 py-3">
        <Button size="sm" leadingIcon={<PlugZap />} loading={test.isPending} onClick={() => test.mutate()}>
          Test
        </Button>
        <Button size="sm" leadingIcon={<RefreshCw />} loading={sync.isPending} onClick={() => sync.mutate()}>
          Sync now
        </Button>
        {canManage && (
          <Tooltip content="Remove connection">
            <IconButton
              size="sm"
              label={`Remove ${connection.name}`}
              icon={<Trash2 />}
              className="ml-auto hover:text-breached-text"
              onClick={() => setConfirm(true)}
            />
          </Tooltip>
        )}
      </div>

      <Dialog
        open={confirm}
        onOpenChange={setConfirm}
        size="sm"
        title={`Remove ${connection.name}?`}
        description="slai stops syncing and evaluating these tickets. History and audit records are kept. You can reconnect at any time."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>
              Remove connection
            </Button>
          </>
        }
      />
    </Card>
  );
}

/** Why a "Continue with <Provider>" flow came back without a connection. */
export const OAUTH_ERRORS: Record<string, string> = {
  denied: "You declined access in the help desk, so nothing was connected.",
  not_configured: "OAuth isn't set up for this help desk on this slai deployment. Connect with credentials instead.",
  invalid_params: "The details entered before signing in weren't valid. Check them and try again.",
  invalid_state: "The sign-in link expired or was used in another browser. Start again from this page.",
  session_mismatch: "Finish connecting as the admin who started it, in the same organization.",
  forbidden: "Only admins can connect a help desk.",
  signed_out: "Sign in again, then connect the help desk.",
  exchange_failed: "The help desk didn't accept the sign-in. Try again, or connect with credentials.",
  invalid_credentials: "The help desk returned credentials slai can't use. Check the app's scopes and try again.",
};

export function oauthErrorMessage(code: string): string {
  return OAUTH_ERRORS[code] ?? "Connecting with OAuth didn't finish. Try again.";
}

/** Shown when any connection has raw statuses or priorities nothing maps yet. */
export function UnmappedBanner({ connections }: { connections: Connection[] }) {
  const affected = connections.filter((c) => c.mappingIssues.length > 0);
  if (affected.length === 0) return null;
  const values = affected.reduce((n, c) => n + c.mappingIssues.length, 0);
  return (
    <div
      role="status"
      className="mb-6 flex flex-wrap items-start gap-x-3 gap-y-1 rounded-md border border-warning-border bg-warning-subtle px-4 py-3 text-sm text-warning-text"
    >
      <Shuffle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <p className="min-w-0 flex-1">
        <span className="font-medium">
          {values === 1 ? "1 help-desk value isn't mapped" : `${values} help-desk values aren't mapped`}
        </span>{" "}
        to a slai status or priority, so those tickets count as open with the policy's default priority. Map them in{" "}
        {affected.map((c, i) => (
          <span key={c.id}>
            {i > 0 && ", "}
            <Link
              to="/connections/$connectionId"
              params={{ connectionId: c.id }}
              search={{}}
              className="font-medium underline"
            >
              {c.name}
            </Link>
          </span>
        ))}
        .
      </p>
    </div>
  );
}

const pageRoute = getRouteApi("/_app/connections");

export function ConnectionsPage() {
  const query = useConnections();
  const me = useMe();
  const canManage = me.data ? ["owner", "admin"].includes(me.data.role) : false;
  const [adding, setAdding] = useState(false);
  const { oauth_error: oauthError } = pageRoute.useSearch();
  const navigate = useNavigate();

  const addButton = canManage ? (
    <Button variant="primary" leadingIcon={<Plus />} onClick={() => setAdding(true)}>
      Add connection
    </Button>
  ) : null;

  return (
    <Page
      title="Connections"
      description="Help desks slai reads tickets from and, within your autonomy rules, writes notes and replies back to."
      actions={addButton}
    >
      {oauthError && (
        <div
          role="alert"
          className="mb-6 flex items-start gap-2 rounded-md border border-breached-border bg-breached-subtle px-3 py-2 text-sm text-breached-text"
        >
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">{oauthErrorMessage(oauthError)}</span>
          <IconButton
            size="sm"
            label="Dismiss"
            icon={<X />}
            onClick={() => navigate({ to: "/connections", search: {}, replace: true })}
          />
        </div>
      )}

      <QueryState
        query={query}
        resource="connections"
        loading={
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" role="status" aria-label="Loading connections">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-64 rounded-lg" />
            ))}
          </div>
        }
        isEmpty={(d) => d.items.length === 0}
        empty={
          <Card>
            <EmptyState
              icon={<Cable />}
              title="No help desk connected"
              description="Connect Zendesk, Jira Service Management, Intercom, Freshdesk, HubSpot and more. slai starts measuring every ticket against your contracts right away."
              action={addButton}
            />
          </Card>
        }
      >
        {(data) => (
          <>
            <UnmappedBanner connections={data.items} />
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {data.items.map((c) => (
                <ConnectionCard key={c.id} connection={c} canManage={canManage} />
              ))}
            </div>
          </>
        )}
      </QueryState>

      <Sheet
        open={adding}
        onOpenChange={setAdding}
        width="lg"
        title="Add a help desk"
        description="Pick your help desk, then paste credentials. slai syncs 90 days of history."
      >
        {adding && (
          <ConnectHelpDesk
            onConnected={(c) => {
              setAdding(false);
              // The detail page shows the webhook URL, secret and setup steps once.
              navigate({
                to: "/connections/$connectionId",
                params: { connectionId: c.id },
                search: { connected: true },
              });
            }}
          />
        )}
      </Sheet>
    </Page>
  );
}
