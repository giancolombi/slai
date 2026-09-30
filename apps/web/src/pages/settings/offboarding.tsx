/**
 * Settings → Organization, owner only (T-64): export all data, and schedule
 * (or cancel) the organization's deletion after the grace period.
 */
import type { OrgExport } from "@slai/shared";
import {
  Badge,
  type BadgeTone,
  Button,
  Card,
  CardContent,
  CardHeader,
  Dialog,
  Field,
  formatDate,
  formatDateTime,
  formatRelative,
  Input,
  Skeleton,
  toast,
} from "@slai/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Archive, Download, Trash2, Undo2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { ErrorState } from "../../components/page";
import { api, errorMessage } from "../../lib/api";
import { qk, useOffboarding } from "../../lib/queries";

const STATUS: Record<OrgExport["status"], { label: string; tone: BadgeTone }> = {
  queued: { label: "Queued", tone: "neutral" },
  running: { label: "Preparing", tone: "accent" },
  succeeded: { label: "Ready", tone: "ok" },
  failed: { label: "Failed", tone: "breached" },
};

function formatBytes(n: number | null): string {
  if (n === null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function ExportCard({ exports }: { exports: OrgExport[] }) {
  const queryClient = useQueryClient();
  const request = useMutation({
    mutationFn: api.offboarding.requestExport,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.offboarding });
      toast({ tone: "success", title: "Export started", description: "It will be ready to download here shortly." });
    },
    onError: (e) => toast({ tone: "error", title: "Couldn't start the export", description: errorMessage(e) }),
  });
  const busy = exports.some((e) => e.status === "queued" || e.status === "running");
  return (
    <Card>
      <CardHeader
        title="Export your data"
        description="One compressed file (.tar.gz) with all your organization's data and contract files. Passwords, keys and other secrets are never included. The download is available for 7 days."
        actions={
          <Button
            size="sm"
            leadingIcon={<Archive />}
            onClick={() => request.mutate()}
            loading={request.isPending}
            disabled={busy}
          >
            Export data
          </Button>
        }
      />
      {exports.length > 0 && (
        <ul className="divide-y divide-line border-t border-line">
          {exports.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-ink">Export of {formatDateTime(e.createdAt)}</p>
                <p className="text-xs text-ink-muted">
                  {e.requestedBy ? `Requested by ${e.requestedBy}` : "Requested"}
                  {e.sizeBytes !== null && ` · ${formatBytes(e.sizeBytes)}`}
                  {e.status === "succeeded" && ` · available until ${formatDate(e.expiresAt)}`}
                  {e.status === "failed" && " · This export didn't finish. Start a new one."}
                </p>
              </div>
              <Badge tone={STATUS[e.status].tone} size="sm">
                {STATUS[e.status].label}
              </Badge>
              {e.status === "succeeded" && (
                <Button asChild size="sm" variant="secondary" leadingIcon={<Download />}>
                  <a href={api.offboarding.exportUrl(e.id)} download>
                    Download
                  </a>
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function DeleteDialog({
  orgName,
  graceDays,
  open,
  onOpenChange,
}: {
  orgName: string;
  graceDays: number;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [typed, setTyped] = useState("");
  const schedule = useMutation({
    mutationFn: () => api.offboarding.scheduleDeletion(typed.trim()),
    onSuccess: (next) => {
      queryClient.setQueryData(qk.offboarding, next);
      toast({ tone: "success", title: "Deletion scheduled", description: `You can cancel it for ${graceDays} days.` });
      onOpenChange(false);
    },
    onError: (e) => toast({ tone: "error", title: "Couldn't schedule deletion", description: errorMessage(e) }),
  });
  const matches = typed.trim() === orgName.trim();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (matches) schedule.mutate();
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Delete this organization?"
      description={`Everything is permanently deleted ${graceDays} days from now: tickets, SLA history, policies, contracts and their files, connections and members' access. Any owner can cancel until then. The audit log is kept for compliance.`}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Keep organization
          </Button>
          <Button
            variant="danger"
            type="submit"
            form="delete-org-form"
            disabled={!matches}
            loading={schedule.isPending}
          >
            Schedule deletion
          </Button>
        </>
      }
    >
      <form id="delete-org-form" onSubmit={submit} noValidate>
        <Field label={`Type ${orgName} to confirm`} hint="Export your data first if you need a copy.">
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
        </Field>
      </form>
    </Dialog>
  );
}

function DeletionCard({
  orgName,
  deletion,
  graceDays,
}: {
  orgName: string;
  deletion: { scheduledFor: string; requestedAt: string; requestedBy: string | null } | null;
  graceDays: number;
}) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const cancel = useMutation({
    mutationFn: api.offboarding.cancelDeletion,
    onSuccess: (next) => {
      queryClient.setQueryData(qk.offboarding, next);
      toast({ tone: "success", title: "Deletion cancelled" });
    },
    onError: (e) => toast({ tone: "error", title: "Couldn't cancel deletion", description: errorMessage(e) }),
  });
  return (
    <Card className="border-breached-border">
      <CardHeader
        title="Delete organization"
        description={`Deletion happens ${graceDays} days after it is requested, and can be cancelled until then.`}
      />
      <CardContent>
        {deletion ? (
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-md border border-breached-border bg-breached-subtle px-4 py-3">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-breached-text" aria-hidden />
              <div>
                <p className="text-sm font-medium text-breached-text">
                  {orgName} will be deleted on {formatDateTime(deletion.scheduledFor)}
                </p>
                <p className="text-xs text-ink-muted">
                  Requested {formatRelative(deletion.requestedAt)}
                  {deletion.requestedBy ? ` by ${deletion.requestedBy}` : ""}.
                </p>
              </div>
            </div>
            <Button
              size="sm"
              variant="secondary"
              leadingIcon={<Undo2 />}
              onClick={() => cancel.mutate()}
              loading={cancel.isPending}
            >
              Cancel deletion
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-4">
            <p className="max-w-md text-sm text-ink-muted">
              Permanently delete this organization and all of its data, including stored contract files.
            </p>
            <Button variant="danger" size="sm" leadingIcon={<Trash2 />} onClick={() => setConfirming(true)}>
              Delete organization…
            </Button>
          </div>
        )}
      </CardContent>
      {confirming && (
        <DeleteDialog orgName={orgName} graceDays={graceDays} open={confirming} onOpenChange={setConfirming} />
      )}
    </Card>
  );
}

export function OffboardingSection({ orgName }: { orgName: string }) {
  const q = useOffboarding();
  if (q.isPending) return <Skeleton className="h-40 rounded-lg" />;
  if (q.isError) return <ErrorState error={q.error} resource="data export and deletion" onRetry={() => q.refetch()} />;
  return (
    <div className="flex flex-col gap-4">
      <ExportCard exports={q.data.exports} />
      <DeletionCard orgName={orgName} deletion={q.data.deletion} graceDays={q.data.graceDays} />
    </div>
  );
}
