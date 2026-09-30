import type { AgentAction } from "@slai/shared";
import { Button, Card, cn, EmptyState, formatRelative, Kbd, Label, Textarea } from "@slai/ui";
import { Link } from "@tanstack/react-router";
import { Inbox, PartyPopper, ShieldAlert } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { GuideButton } from "../../help/guide-button";
import { ActionKindLabel, ActionStatusBadge, ConfidenceMeter, RejectDialog, UsedKnowledge } from "./draft-parts";
import { useInboxKeys } from "./use-inbox-keys";

export interface ApprovalsInboxProps {
  items: AgentAction[];
  onApprove: (item: AgentAction, body: string) => void;
  onReject: (item: AgentAction, reason: string | undefined) => void;
  /** The id currently being approved/rejected (disables its buttons). */
  pendingId?: string | null;
  /** Extra ticket context for the selected draft (e.g. live SLA clock). */
  renderContext?: (item: AgentAction) => ReactNode;
  /** How to link to the ticket; defaults to plain text. */
  renderTicketLink?: (item: AgentAction, children: ReactNode) => ReactNode;
}

/**
 * The keyboard-first approvals inbox (presentational: no router or network).
 * j/k move, a approves the selected draft (with any edits), r rejects it, e edits, Esc leaves the editor.
 */
export function ApprovalsInbox({
  items,
  onApprove,
  onReject,
  pendingId = null,
  renderContext,
  renderTicketLink = (_item, children) => children,
}: ApprovalsInboxProps) {
  const [selectedId, setSelectedId] = useState<string | null>(items[0]?.id ?? null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [rejecting, setRejecting] = useState(false);
  const lastIndex = useRef(0);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const editorId = useId();

  const index = items.findIndex((i) => i.id === selectedId);
  const selected = index >= 0 ? items[index] : undefined;
  if (index >= 0) lastIndex.current = index;

  // Auto-advance: when the selected draft leaves the list, select whatever took its place.
  useEffect(() => {
    if (items.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (!items.some((i) => i.id === selectedId)) {
      setSelectedId(items[Math.min(lastIndex.current, items.length - 1)]!.id);
    }
  }, [items, selectedId]);

  // Keep the selected row in view.
  useEffect(() => {
    if (!selectedId) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(selectedId)}"]`);
    el?.scrollIntoView?.({ block: "nearest" });
  }, [selectedId]);

  const move = (delta: number) => {
    if (items.length === 0) return;
    const next = Math.min(items.length - 1, Math.max(0, (index < 0 ? 0 : index) + delta));
    setSelectedId(items[next]!.id);
  };
  const bodyOf = (item: AgentAction) => edits[item.id] ?? item.body ?? "";
  const approve = () => {
    if (!selected || pendingId === selected.id || !bodyOf(selected).trim()) return;
    onApprove(selected, bodyOf(selected));
  };
  const reject = (reason?: string) => {
    if (!selected || pendingId === selected.id) return;
    onReject(selected, reason);
  };

  useInboxKeys(
    {
      onNext: () => move(1),
      onPrev: () => move(-1),
      onApprove: approve,
      onReject: () => reject(undefined),
      onEdit: () => editorRef.current?.focus(),
    },
    !rejecting,
  );

  if (items.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<PartyPopper />}
          title="Inbox zero"
          description="No drafts are waiting. New drafts land here when a ticket reaches its trigger risk under an Assist rule, or when autopilot holds one back. With every rule on Observe, there are none."
          action={
            <>
              <Button asChild size="sm" variant="secondary">
                <Link to="/autonomy">Review autonomy</Link>
              </Button>
              <GuideButton guide="approvals" />
            </>
          }
        />
      </Card>
    );
  }

  const busy = selected ? pendingId === selected.id : false;
  const edited = selected ? edits[selected.id] !== undefined && edits[selected.id] !== selected.body : false;

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-[minmax(260px,340px)_minmax(0,1fr)]">
      <Card className="flex min-h-0 flex-col overflow-hidden md:max-h-[calc(100dvh-220px)]">
        <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
          <span className="text-xs font-medium text-ink-muted">
            <span className="font-mono text-ink tnum">{items.length}</span> awaiting decision
          </span>
          <Inbox className="size-4 text-ink-subtle" aria-hidden />
        </div>
        <div
          ref={listRef}
          role="listbox"
          tabIndex={0}
          aria-label="Drafts awaiting approval"
          aria-activedescendant={selected ? `draft-${selected.id}` : undefined}
          className="min-h-0 flex-1 overflow-y-auto scrollbar-thin focus-visible:-outline-offset-2"
        >
          {items.map((item) => {
            const active = item.id === selected?.id;
            return (
              // biome-ignore lint/a11y/useKeyWithClickEvents: j/k and arrow keys drive selection globally
              <div
                key={item.id}
                id={`draft-${item.id}`}
                data-id={item.id}
                role="option"
                tabIndex={-1}
                aria-selected={active}
                onClick={() => setSelectedId(item.id)}
                className={cn(
                  "relative cursor-pointer border-b border-line px-4 py-3 transition-colors last:border-b-0",
                  active ? "bg-accent-subtle/70" : "hover:bg-hover",
                )}
              >
                {active && <span aria-hidden className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-accent" />}
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-xs text-ink-muted">{item.ticketKey}</span>
                  <span className="text-2xs text-ink-subtle">{formatRelative(item.createdAt)}</span>
                </div>
                <p className="mt-0.5 line-clamp-2 text-sm font-medium text-ink">{item.ticketSubject}</p>
                <div className="mt-1.5 flex items-center justify-between gap-2">
                  <ActionKindLabel kind={item.kind} />
                  {item.status === "blocked" ? (
                    <span className="inline-flex items-center gap-1 text-2xs font-medium text-warning-text">
                      <ShieldAlert className="size-3" aria-hidden /> Guardrail
                    </span>
                  ) : (
                    <ConfidenceMeter value={item.confidence} />
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line bg-sunken/40 px-4 py-2 text-2xs text-ink-muted">
          <span className="inline-flex items-center gap-1">
            <Kbd>j</Kbd>
            <Kbd>k</Kbd> move
          </span>
          <span className="inline-flex items-center gap-1">
            <Kbd>a</Kbd> approve
          </span>
          <span className="inline-flex items-center gap-1">
            <Kbd>r</Kbd> reject
          </span>
          <span className="inline-flex items-center gap-1">
            <Kbd>e</Kbd> edit
          </span>
          <span className="inline-flex items-center gap-1">
            <Kbd>Esc</Kbd> done editing
          </span>
        </div>
      </Card>

      {selected && (
        <Card className="flex min-w-0 flex-col" aria-label={`Draft for ${selected.ticketKey}`}>
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-xs text-ink-muted">
                <span className="font-mono">{selected.ticketKey}</span>
                <ActionStatusBadge status={selected.status} />
              </div>
              <h2 className="mt-1 text-md font-semibold text-ink">
                {renderTicketLink(selected, selected.ticketSubject)}
              </h2>
            </div>
            <div className="flex flex-col items-end gap-1">
              <ActionKindLabel kind={selected.kind} />
              <ConfidenceMeter value={selected.confidence} />
            </div>
          </div>
          <div className="flex flex-1 flex-col gap-4 px-5 py-4">
            {selected.status === "blocked" && selected.blockedReason && (
              <div
                role="note"
                className="flex gap-2.5 rounded-md border border-warning-border bg-warning-subtle px-3 py-2.5 text-sm text-warning-text"
              >
                <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                <div>
                  <p className="font-semibold">Autopilot held this draft</p>
                  <p>{selected.blockedReason}</p>
                </div>
              </div>
            )}
            {renderContext?.(selected)}
            {selected.kind === "public_reply" && <UsedKnowledge refs={selected.usedKnowledge} />}
            <div className="flex flex-1 flex-col gap-1.5">
              <div className="flex items-baseline justify-between">
                <Label htmlFor={editorId}>
                  {selected.kind === "internal_note" ? "Internal note" : "Reply to the customer"}
                </Label>
                {edited && (
                  <button
                    type="button"
                    className="text-xs font-medium text-accent-text hover:underline"
                    onClick={() =>
                      setEdits((e) => {
                        const { [selected.id]: _, ...rest } = e;
                        return rest;
                      })
                    }
                  >
                    Discard edits
                  </button>
                )}
              </div>
              <Textarea
                ref={editorRef}
                id={editorId}
                value={bodyOf(selected)}
                onChange={(e) => setEdits((prev) => ({ ...prev, [selected.id]: e.target.value }))}
                rows={10}
                className="min-h-56 flex-1 font-sans"
              />
              <p className="text-xs text-ink-muted">
                {edited
                  ? "Edited. Your version will be sent."
                  : "Drafted by the agent in a sandbox. Edit freely before sending."}
              </p>
            </div>
          </div>
          <div className="mt-auto flex flex-wrap items-center justify-end gap-2 border-t border-line bg-sunken/40 px-5 py-3">
            <Button onClick={() => setRejecting(true)} disabled={busy} trailingIcon={<Kbd>r</Kbd>}>
              Reject…
            </Button>
            <Button
              variant="primary"
              onClick={approve}
              loading={busy}
              disabled={!bodyOf(selected).trim()}
              trailingIcon={<Kbd className="border-white/30 bg-white/15 text-on-accent">a</Kbd>}
            >
              {selected.kind === "public_reply" ? "Approve & send" : "Approve & post"}
            </Button>
          </div>
        </Card>
      )}

      <RejectDialog
        open={rejecting}
        onOpenChange={setRejecting}
        subject={selected?.ticketSubject}
        loading={busy}
        onConfirm={(reason) => {
          reject(reason);
          setRejecting(false);
        }}
      />
    </div>
  );
}
