import type { Connection, FieldMappingTable } from "@slai/shared";
import { Badge, Button, Card, formatNumber, formatRelative, Skeleton, toast } from "@slai/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { ArrowLeft, CircleAlert, PlugZap, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Page, QueryState } from "../../components/page";
import { useAccess } from "../../lib/access";
import { api, errorMessage } from "../../lib/api";
import { providerLabel } from "../../lib/labels";
import { qk, useConnection, useConnectionMapping, useMe } from "../../lib/queries";
import { CONNECTION_STATUS } from "./connections";
import { MappingEditor } from "./mapping-editor";
import { ProviderMark } from "./provider-mark";
import { WebhookSetup } from "./webhook-setup";

const route = getRouteApi("/_app/connections/$connectionId");

function Mapping({ connectionId, canEdit }: { connectionId: string; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const query = useConnectionMapping(connectionId);
  const save = useMutation({
    mutationFn: (overrides: FieldMappingTable) => api.connections.updateMapping(connectionId, overrides),
    onSuccess: (m) => {
      queryClient.setQueryData(qk.connectionMapping(connectionId), m);
      queryClient.invalidateQueries({ queryKey: qk.connections });
      queryClient.invalidateQueries({ queryKey: ["tickets"] });
      toast({
        tone: "success",
        title: "Mapping saved",
        description: "Open tickets are being re-evaluated with the new mapping.",
      });
    },
    onError: (e) => toast({ tone: "error", title: "Couldn't save the mapping", description: errorMessage(e) }),
  });
  return (
    <QueryState query={query} resource="the mapping" loading={<Skeleton className="h-72 rounded-lg" />}>
      {(m) => (
        // Re-key on the saved overrides so the editor's draft resets after a save or reset.
        <MappingEditor
          key={JSON.stringify(m.overrides)}
          mapping={m}
          canEdit={canEdit}
          saving={save.isPending}
          onSave={(o) => save.mutate(o)}
        />
      )}
    </QueryState>
  );
}

function Detail({
  connection,
  canManage,
  justConnected,
}: {
  connection: Connection;
  canManage: boolean;
  justConnected: boolean;
}) {
  const queryClient = useQueryClient();
  const { canWork } = useAccess();
  const status = CONNECTION_STATUS[connection.status];
  const test = useMutation({
    mutationFn: () => api.connections.test(connection.id),
    onSuccess: (r) =>
      toast({ tone: "success", title: "Connection works", description: `Signed in as ${r.accountName}.` }),
    onError: (e) => toast({ tone: "error", title: "Connection test failed", description: errorMessage(e) }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: qk.connection(connection.id) }),
  });
  const sync = useMutation({
    mutationFn: () => api.connections.sync(connection.id),
    onSuccess: () =>
      toast({ tone: "info", title: "Sync started", description: "New and changed tickets will appear in a minute." }),
    onError: (e) => toast({ tone: "error", title: "Couldn't start a sync", description: errorMessage(e) }),
  });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <ProviderMark provider={connection.provider} size="lg" />
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight text-ink">{connection.name}</h1>
              <Badge tone={status.tone} size="sm" icon={status.icon}>
                {status.label}
              </Badge>
            </div>
            <p className="mt-0.5 text-sm text-ink-muted">
              {providerLabel(connection.provider)} · {formatNumber(connection.ticketCount)} tickets tracked · last sync{" "}
              {connection.lastSyncAt ? (
                <time dateTime={connection.lastSyncAt}>{formatRelative(connection.lastSyncAt)}</time>
              ) : (
                "never"
              )}
            </p>
          </div>
        </div>
        {canWork && (
          <div className="flex items-center gap-2">
            <Button size="sm" leadingIcon={<PlugZap />} loading={test.isPending} onClick={() => test.mutate()}>
              Test
            </Button>
            <Button size="sm" leadingIcon={<RefreshCw />} loading={sync.isPending} onClick={() => sync.mutate()}>
              Sync now
            </Button>
          </div>
        )}
      </div>

      {connection.status === "error" && connection.lastError && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-breached-border bg-breached-subtle px-3 py-2 text-sm text-breached-text"
        >
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>{connection.lastError}</span>
        </div>
      )}

      {!canManage ? null : connection.webhookUrl ? (
        <WebhookSetup
          connectionId={connection.id}
          webhookUrl={connection.webhookUrl}
          canReveal={canManage}
          autoReveal={justConnected}
        />
      ) : (
        <Card className="px-5 py-4 text-sm text-ink-muted">
          {providerLabel(connection.provider)} doesn't send slai updates directly, so slai checks it for changes every
          few minutes. There's nothing to set up.
        </Card>
      )}

      <Mapping connectionId={connection.id} canEdit={canManage} />
    </div>
  );
}

export function ConnectionDetailPage() {
  const { connectionId } = route.useParams();
  const { connected } = route.useSearch();
  const navigate = route.useNavigate();
  const query = useConnection(connectionId);
  const me = useMe();
  const canManage = me.data ? ["owner", "admin"].includes(me.data.role) : false;
  // Captured once: the search param is cleared right away, before the connection may have loaded.
  const [justConnected] = useState(Boolean(connected));

  useEffect(() => {
    if (!connected) return;
    toast({ tone: "success", title: "Help desk connected", description: "Syncing tickets now." });
    // One-shot: a reload must not reveal the secret (and write an audit event) again.
    navigate({ search: {}, replace: true });
  }, [connected, navigate]);

  return (
    <Page docTitle={query.data?.name ?? "Connection"}>
      <div className="mb-4">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link to="/connections" search={{}}>
            <ArrowLeft aria-hidden /> All connections
          </Link>
        </Button>
      </div>
      <QueryState
        query={query}
        resource="this connection"
        loading={
          <div className="flex flex-col gap-4" role="status" aria-label="Loading connection">
            <Skeleton className="h-10 w-1/2" />
            <Skeleton className="h-40 rounded-lg" />
            <Skeleton className="h-72 rounded-lg" />
          </div>
        }
      >
        {(c) => <Detail connection={c} canManage={canManage} justConnected={justConnected} />}
      </QueryState>
    </Page>
  );
}
