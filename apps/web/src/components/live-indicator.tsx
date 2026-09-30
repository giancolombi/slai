import { cn } from "@slai/ui";
import { type LiveStatus, useLiveStatus } from "../lib/live";

const META: Record<Exclude<LiveStatus, "off">, { label: string; detail: string; dot: string; text: string }> = {
  live: {
    label: "Live",
    detail: "Live updates are on: changes appear as they happen.",
    dot: "bg-ok",
    text: "text-ink-muted",
  },
  connecting: {
    label: "Connecting",
    detail: "Connecting to live updates…",
    dot: "bg-ink-subtle",
    text: "text-ink-subtle",
  },
  reconnecting: {
    label: "Reconnecting",
    detail: "Live updates are interrupted. Retrying; until then this page refreshes every minute.",
    dot: "bg-warning animate-pulse-ring text-warning",
    text: "text-warning-text",
  },
};

/** A quiet top-bar status for the live-update stream. Announced politely when it changes. */
export function LiveIndicator({ className }: { className?: string }) {
  const status = useLiveStatus();
  if (status === "off") return null;
  const m = META[status];
  return (
    <span
      role="status"
      title={m.detail}
      className={cn("inline-flex items-center gap-1.5 px-1.5 text-2xs font-medium select-none", m.text, className)}
    >
      <span aria-hidden className={cn("inline-block size-1.5 shrink-0 rounded-full", m.dot)} />
      <span className="hidden sm:inline">{m.label}</span>
      <span className="sr-only">{m.detail}</span>
    </span>
  );
}
