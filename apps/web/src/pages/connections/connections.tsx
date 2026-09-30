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
import {
  Cable,
  CircleAlert,
  CircleCheck,
  CirclePause,
  Copy,
  PlugZap,
  Plus,
  RefreshCw,
  Trash2,
  Webhook,
} from "lucide-react";
import { useState } from "react";
import { Page, QueryState } from "../../components/page";
import { api, errorMessage } from "../../lib/api";
import { providerLabel } from "../../lib/labels";
import { qk, useConnections, useMe } from "../../lib/queries";
import { ConnectHelpDesk } from "./connector-form";
import { ProviderMark } from "./provider-mark";

const STATUS: Record<Connection["status"], { label: string; tone: BadgeTone; icon: React.ReactNode }> = {
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
  const status = STATUS[connection.status];

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
            <h2 className="truncate text-md font-semibold text-ink">{connection.name}</h2>
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

export function ConnectionsPage() {
  const query = useConnections();
  const me = useMe();
  const canManage = me.data ? ["owner", "admin"].includes(me.data.role) : false;
  const [adding, setAdding] = useState(false);

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
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {data.items.map((c) => (
              <ConnectionCard key={c.id} connection={c} canManage={canManage} />
            ))}
          </div>
        )}
      </QueryState>

      <Sheet
        open={adding}
        onOpenChange={setAdding}
        width="lg"
        title="Add a help desk"
        description="Pick your help desk, then paste credentials. slai syncs 90 days of history."
      >
        {adding && <ConnectHelpDesk onConnected={() => setAdding(false)} />}
      </Sheet>
    </Page>
  );
}
