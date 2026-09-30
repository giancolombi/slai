import type { ActionKind, ActionStatus } from "@slai/shared";
import { Badge, type BadgeTone, Button, cn, Dialog, Field, Textarea } from "@slai/ui";
import { Ban, Check, Globe, Lock, ShieldAlert, X } from "lucide-react";
import { useEffect, useState } from "react";
import { ACTION_STATUS_LABEL } from "../../lib/labels";

const STATUS_TONE: Record<ActionStatus, BadgeTone> = {
  proposed: "accent",
  approved: "ok",
  sending: "ok",
  sent: "ok",
  rejected: "neutral",
  failed: "breached",
  blocked: "warning",
};

export function ActionStatusBadge({ status }: { status: ActionStatus }) {
  const icon =
    status === "sent" || status === "approved" ? (
      <Check aria-hidden />
    ) : status === "rejected" ? (
      <X aria-hidden />
    ) : status === "blocked" ? (
      <ShieldAlert aria-hidden />
    ) : status === "failed" ? (
      <Ban aria-hidden />
    ) : undefined;
  return (
    <Badge tone={STATUS_TONE[status]} size="sm" icon={icon}>
      {ACTION_STATUS_LABEL[status]}
    </Badge>
  );
}

export function ActionKindLabel({ kind }: { kind: ActionKind }) {
  const pub = kind === "public_reply";
  const Icon = pub ? Globe : Lock;
  const label =
    kind === "public_reply"
      ? "Public reply"
      : kind === "internal_note"
        ? "Internal note"
        : kind === "set_priority"
          ? "Set priority"
          : "Assign";
  return (
    <span
      className={cn("inline-flex items-center gap-1 text-xs font-medium", pub ? "text-accent-text" : "text-ink-muted")}
    >
      <Icon className="size-3.5" aria-hidden />
      {label}
    </span>
  );
}

/** Model confidence as a thin meter with the number beside it. */
export function ConfidenceMeter({ value, className }: { value: number | null; className?: string }) {
  if (value === null) return <span className="text-xs text-ink-subtle">No confidence score</span>;
  const pct = Math.round(value * 100);
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      {/* biome-ignore lint/a11y/useSemanticElements: styled meter; native <meter> can't be themed consistently */}
      <span
        role="meter"
        aria-label="Model confidence"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        className="relative h-1.5 w-16 overflow-hidden rounded-full bg-sunken"
      >
        <span className="absolute inset-y-0 left-0 rounded-full bg-accent" style={{ width: `${pct}%` }} />
      </span>
      <span className="font-mono text-xs text-ink-muted tnum">{pct}%</span>
    </span>
  );
}

export function RejectDialog({
  open,
  onOpenChange,
  onConfirm,
  loading,
  subject,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (reason: string | undefined) => void;
  loading?: boolean;
  subject?: string;
}) {
  const [reason, setReason] = useState("");
  useEffect(() => {
    if (open) setReason("");
  }, [open]);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Reject draft"
      description={
        subject ? `The draft for “${subject}” won't be sent. The reason helps tune future drafts.` : undefined
      }
      size="sm"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="danger" loading={loading} onClick={() => onConfirm(reason.trim() || undefined)}>
            Reject draft
          </Button>
        </>
      }
    >
      <Field label="Reason" hint="Optional. Visible in the audit log.">
        <Textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Tone too casual for this customer"
          rows={3}
          maxLength={2000}
        />
      </Field>
    </Dialog>
  );
}
