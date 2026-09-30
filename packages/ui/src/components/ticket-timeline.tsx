import {
  ArrowUpDown,
  Bot,
  CircleDot,
  Globe,
  Lock,
  type LucideIcon,
  MessageSquare,
  OctagonX,
  Pause,
  Play,
  TriangleAlert,
  UserRound,
} from "lucide-react";
import { cn } from "../lib/cn";
import { formatDate, formatTime } from "../lib/format";

export interface TimelineItem {
  at: string;
  type: string;
  label: string;
  author?: string;
  /** true: public reply/comment; false: internal note; undefined: a system event. */
  public?: boolean;
}

export interface TicketTimelineProps {
  items: TimelineItem[];
  /** Newest first. Default false (chronological). */
  reverse?: boolean;
  className?: string;
}

const eventIcons: Record<string, LucideIcon> = {
  created: CircleDot,
  status_changed: ArrowUpDown,
  priority_changed: ArrowUpDown,
  assigned: UserRound,
  paused: Pause,
  resumed: Play,
  sla_warning: TriangleAlert,
  sla_at_risk: TriangleAlert,
  sla_breached: OctagonX,
  agent: Bot,
};

function kindOf(item: TimelineItem): "public" | "internal" | "event" {
  if (item.public === true) return "public";
  if (item.public === false) return "internal";
  return "event";
}

/**
 * A ticket's event history. Public replies and internal notes are distinguished by
 * marker, label, background and an icon — not just color — because only public
 * replies count toward response SLAs.
 */
export function TicketTimeline({ items, reverse = false, className }: TicketTimelineProps) {
  const sorted = [...items].sort((a, b) => (reverse ? -1 : 1) * (new Date(a.at).getTime() - new Date(b.at).getTime()));
  let lastDay = "";
  return (
    <ol className={cn("relative flex flex-col", className)} aria-label="Ticket timeline">
      {sorted.map((item, i) => {
        const kind = kindOf(item);
        const day = formatDate(item.at);
        const showDay = day !== lastDay;
        lastDay = day;
        const Icon =
          kind === "public"
            ? Globe
            : kind === "internal"
              ? Lock
              : (eventIcons[item.type] ?? (item.type.startsWith("agent") ? Bot : MessageSquare));
        const tone =
          item.type === "sla_breached"
            ? "text-breached-text border-breached-border bg-breached-subtle"
            : item.type === "sla_at_risk"
              ? "text-at-risk-text border-at-risk-border bg-at-risk-subtle"
              : item.type === "sla_warning"
                ? "text-warning-text border-warning-border bg-warning-subtle"
                : kind === "public"
                  ? "text-accent-text border-accent/30 bg-accent-subtle"
                  : kind === "internal"
                    ? "text-ink-muted border-dashed border-ink-subtle bg-surface"
                    : "text-ink-subtle border-line bg-surface";
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: timeline events have no id; the list is sorted and append-only
          <li key={`${item.at}-${item.type}-${i}`} className="relative flex gap-3 pb-4 last:pb-0">
            {i < sorted.length - 1 && <span aria-hidden className="absolute top-7 bottom-0 left-[13px] w-px bg-line" />}
            <span
              aria-hidden
              className={cn(
                "relative z-[1] mt-0.5 flex size-[27px] shrink-0 items-center justify-center rounded-full border [&_svg]:size-3.5",
                tone,
              )}
            >
              <Icon />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs text-ink-muted">
                {item.author && <span className="font-medium text-ink">{item.author}</span>}
                {kind === "public" && <span className="font-medium text-accent-text">Public reply</span>}
                {kind === "internal" && (
                  <span className="inline-flex items-center gap-1 font-medium text-ink-muted">Internal note</span>
                )}
                <time dateTime={item.at} className="font-mono tnum">
                  {showDay ? `${day}, ` : ""}
                  {formatTime(item.at)}
                </time>
              </div>
              {kind === "event" ? (
                <p className="mt-0.5 text-sm text-ink-muted">{item.label}</p>
              ) : (
                <p
                  className={cn(
                    "mt-1.5 rounded-md border px-3 py-2 text-sm leading-relaxed whitespace-pre-line",
                    kind === "public"
                      ? "border-line bg-surface text-ink"
                      : "border-dashed border-line-strong bg-sunken/70 text-ink",
                  )}
                >
                  {item.label}
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
