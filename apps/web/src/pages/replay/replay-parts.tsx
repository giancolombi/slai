import type { Connection, Replay } from "@slai/shared";
import {
  Badge,
  type BadgeTone,
  Button,
  cn,
  Field,
  formatDuration,
  formatMoney,
  formatNumber,
  formatPercent,
  Progress,
  SegmentedControl,
  Select,
  toast,
} from "@slai/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, CircleCheck, Clock3, History, LoaderCircle } from "lucide-react";
import { type FormEvent, useState } from "react";
import { api, errorMessage } from "../../lib/api";
import { providerLabel } from "../../lib/labels";
import { qk } from "../../lib/queries";

export const REPLAY_STATUS: Record<Replay["status"], { label: string; tone: BadgeTone; icon: React.ReactNode }> = {
  queued: { label: "Queued", tone: "neutral", icon: <Clock3 aria-hidden /> },
  running: { label: "Running", tone: "accent", icon: <LoaderCircle className="animate-spin" aria-hidden /> },
  succeeded: { label: "Complete", tone: "ok", icon: <CircleCheck aria-hidden /> },
  failed: { label: "Failed", tone: "breached", icon: <CircleAlert aria-hidden /> },
};

export function ReplayStatusBadge({ status }: { status: Replay["status"] }) {
  const s = REPLAY_STATUS[status];
  return (
    <Badge tone={s.tone} size="sm" icon={s.icon}>
      {s.label}
    </Badge>
  );
}

/** "3h 16m" from minutes. */
export function leadTime(minutes: number | null) {
  return minutes === null ? "—" : formatDuration(minutes * 60_000);
}

export function ReplayProgress({ replay, className }: { replay: Replay; className?: string }) {
  const { ticketsScanned, ticketsTotal } = replay.progress;
  const pct = ticketsTotal ? (ticketsScanned / ticketsTotal) * 100 : undefined;
  return (
    <div className={cn("flex flex-col gap-2", className)} aria-live="polite">
      <Progress value={replay.status === "queued" ? undefined : pct} label="Replay progress" />
      <p className="flex justify-between text-xs text-ink-muted">
        <span>
          {replay.status === "queued" ? "Queued: starting shortly" : "Replaying tickets against your policies"}
        </span>
        <span className="font-mono tnum">
          {formatNumber(ticketsScanned)}
          {ticketsTotal ? ` / ${formatNumber(ticketsTotal)}` : ""} tickets
        </span>
      </p>
    </div>
  );
}

const DAYS = [30, 60, 90] as const;

export interface RunReplayFormProps {
  connections: Connection[];
  onStarted: (replay: Replay) => void;
  submitLabel?: string;
  className?: string;
}

/** Choose a connection and a window, then start a replay. */
export function RunReplayForm({
  connections,
  onStarted,
  submitLabel = "Run Breach Replay",
  className,
}: RunReplayFormProps) {
  const queryClient = useQueryClient();
  const [connectionId, setConnectionId] = useState(connections[0]?.id);
  const [days, setDays] = useState<number>(90);
  const start = useMutation({
    mutationFn: () => api.replays.create({ connectionId: connectionId!, days }),
    onSuccess: (r) => {
      queryClient.invalidateQueries({ queryKey: qk.replays });
      onStarted(r);
    },
    onError: (e) => toast({ tone: "error", title: "Couldn't start the replay", description: errorMessage(e) }),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (connectionId) start.mutate();
  };
  return (
    <form onSubmit={submit} className={cn("flex flex-col gap-4", className)}>
      <Field label="Help desk">
        <Select
          value={connectionId}
          onValueChange={setConnectionId}
          options={connections.map((c) => ({
            value: c.id,
            label: `${c.name} · ${providerLabel(c.provider)}`,
          }))}
          placeholder="Choose a connection"
        />
      </Field>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1.5 text-sm font-medium text-ink">Look back</legend>
        <SegmentedControl
          aria-label="Days to replay"
          value={String(days)}
          onValueChange={(v) => setDays(Number(v))}
          options={DAYS.map((d) => ({ value: String(d), label: `${d} days` }))}
          className="self-start"
        />
      </fieldset>
      <Button
        type="submit"
        variant="primary"
        leadingIcon={<History />}
        loading={start.isPending}
        disabled={!connectionId}
      >
        {submitLabel}
      </Button>
    </form>
  );
}

/** The four headline numbers of a finished replay. */
export function ReplayHeadline({ result, compact }: { result: NonNullable<Replay["result"]>; compact?: boolean }) {
  const items = [
    { label: "Credit exposure", value: formatMoney(result.exposureCents), strong: true },
    { label: "Breaches missed", value: formatNumber(result.breaches) },
    { label: "Attainment", value: formatPercent(result.attainmentPercent) },
    { label: "Median warning", value: leadTime(result.medianLeadMinutes) },
  ];
  return (
    <dl className={cn("grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line md:grid-cols-4")}>
      {items.map((i) => (
        <div key={i.label} className={cn("bg-surface", compact ? "p-3" : "p-4")}>
          <dt className="text-xs text-ink-muted">{i.label}</dt>
          <dd
            className={cn(
              "mt-1 font-mono tracking-tight tnum",
              compact ? "text-lg" : "text-2xl",
              i.strong ? "text-breached-text" : "text-ink",
            )}
          >
            {i.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
