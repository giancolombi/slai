import type { ActionKind, ActionStatus, AgentAction, KnowledgeRef, Priority } from "@slai/shared";
import { Badge, type BadgeTone, Button, cn, Dialog, Field, Textarea } from "@slai/ui";
import { Ban, BookOpen, Check, ExternalLink, Globe, Lock, ShieldAlert, X } from "lucide-react";
import { useEffect, useState } from "react";
import { safeHref, uniqueRefs, urlHost } from "../../lib/knowledge";
import { ACTION_STATUS_LABEL, PRIORITY_LABEL } from "../../lib/labels";

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

/** How confident the agent is in its draft, as a thin meter with the number beside it. */
export function ConfidenceMeter({ value, className }: { value: number | null; className?: string }) {
  if (value === null) return <span className="text-xs text-ink-subtle">No confidence score</span>;
  const pct = Math.round(value * 100);
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      {/* biome-ignore lint/a11y/useSemanticElements: styled meter; native <meter> can't be themed consistently */}
      <span
        role="meter"
        aria-label="Agent confidence"
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

/** Replies and notes carry text to edit; priority and assignee changes don't. */
export function isTextAction(kind: ActionKind): boolean {
  return kind === "public_reply" || kind === "internal_note";
}

const priorityName = (p: unknown) =>
  typeof p === "string" && p in PRIORITY_LABEL ? PRIORITY_LABEL[p as Priority].toLowerCase() : null;

/** A plain sentence for a proposed ticket change (priority or assignee), with the agent's reason. */
export function ProposedChange({ action }: { action: Pick<AgentAction, "kind" | "payload"> }) {
  const p = (action.payload ?? {}) as { priority?: unknown; from?: unknown; reason?: unknown };
  let what: string;
  if (action.kind === "set_priority") {
    const to = priorityName(p.priority);
    const from = priorityName(p.from);
    what = to
      ? from
        ? `Change the priority from ${from} to ${to}.`
        : `Set the priority to ${to}.`
      : "Change the ticket's priority.";
  } else {
    what = "Assign the ticket to the teammate the agent suggests, in your help desk.";
  }
  return (
    <div className="rounded-md border border-line bg-sunken/40 px-3 py-2.5 text-sm">
      <p className="font-medium text-ink">{what}</p>
      {typeof p.reason === "string" && p.reason.trim() && <p className="mt-1 text-ink-muted">{p.reason}</p>}
    </div>
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

/**
 * The knowledge articles a draft relied on, as links. `compact` is a single line for lists;
 * otherwise a small panel that also says so when the draft used no knowledge.
 */
export function UsedKnowledge({
  refs,
  compact,
  className,
}: {
  refs: KnowledgeRef[] | undefined;
  compact?: boolean;
  className?: string;
}) {
  const items = uniqueRefs(refs);
  const link = (r: KnowledgeRef) => {
    const href = safeHref(r.url);
    const title = r.id === null ? `${r.title} (removed)` : r.title;
    return href ? (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="inline-flex min-w-0 items-center gap-1 text-accent-text hover:underline"
        title={urlHost(href) ?? undefined}
      >
        <span className="truncate">{title}</span>
        <ExternalLink className="size-3 shrink-0" aria-hidden />
        <span className="sr-only">(opens in a new tab)</span>
      </a>
    ) : (
      <span className="truncate text-ink">{title}</span>
    );
  };
  if (compact) {
    if (items.length === 0) return null;
    return (
      <p className={cn("flex min-w-0 items-center gap-1.5 text-2xs text-ink-muted", className)}>
        <BookOpen className="size-3 shrink-0" aria-hidden />
        <span className="shrink-0">Used:</span>
        <span className="flex min-w-0 flex-wrap gap-x-2">
          {items.map((r, i) => (
            <span key={r.id ?? `${r.title}-${i}`} className="min-w-0">
              {link(r)}
            </span>
          ))}
        </span>
      </p>
    );
  }
  return (
    <section
      aria-label="Knowledge used by this draft"
      className={cn("rounded-md border border-line bg-sunken/40 px-3 py-2.5", className)}
    >
      <h3 className="flex items-center gap-1.5 text-xs font-semibold text-ink">
        <BookOpen className="size-3.5 text-ink-muted" aria-hidden />
        Knowledge used
      </h3>
      {items.length === 0 ? (
        <p className="mt-1 text-xs text-ink-muted">
          No knowledge used. The draft relies on the ticket thread only, so check its facts before sending.
        </p>
      ) : (
        <ul className="mt-1.5 flex flex-col gap-1 text-sm">
          {items.map((r, i) => (
            <li key={r.id ?? `${r.title}-${i}`} className="flex min-w-0 items-center">
              {link(r)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
