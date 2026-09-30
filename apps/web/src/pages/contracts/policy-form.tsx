import type { CreditAmount, CreditRule, Metric, Priority, SlaPolicy, TicketStatus } from "@slai/sla-engine";
import {
  Button,
  Card,
  Checkbox,
  cn,
  formatDuration,
  IconButton,
  Input,
  Label,
  Select,
  Switch,
  Tooltip,
} from "@slai/ui";
import { CircleAlert, CircleHelp, Plus, Quote, Trash2, X } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { METRIC_LABEL, PRIORITIES, PRIORITY_LABEL } from "../../lib/labels";
import { fieldDomId, METRICS, pathLabel, targetPath, WEEKDAY_LABEL, WEEKDAYS, type Weekday } from "./policy-paths";
import { useReview } from "./review-context";

type Update = (mutate: (draft: SlaPolicy) => void) => void;

export interface PolicyFormProps {
  value: SlaPolicy;
  onChange: (next: SlaPolicy) => void;
}

/** The extracted policy as an editable form. Every section links to its contract citation. */
export function PolicyForm({ value, onChange }: PolicyFormProps) {
  const update: Update = (mutate) => {
    const next = structuredClone(value);
    mutate(next);
    onChange(next);
  };
  return (
    <div className="flex flex-col gap-5">
      <BasicsSection value={value} update={update} />
      <CalendarSection value={value} update={update} />
      <TargetsSection value={value} update={update} />
      <PausesSection value={value} update={update} />
      <CreditsSection value={value} update={update} />
    </div>
  );
}

// ---------------------------------------------------------------- linking primitives

/** A citation chip: "p.12" when the contract backs this value, a quiet marker when nothing does. */
export function CitationMarker({ path, compact }: { path: string; compact?: boolean }) {
  const { citations, showCitation, unresolved, ambiguous } = useReview();
  const cite = citations.get(path);
  const needs = unresolved.has(path);
  return (
    <span className="inline-flex items-center gap-1.5">
      {ambiguous.has(path) && (
        <span
          className={cn(
            "inline-flex items-center gap-1 text-2xs font-medium",
            needs ? "text-warning-text" : "text-ok-text",
          )}
        >
          <CircleHelp className="size-3" aria-hidden />
          {compact ? (
            <span className="sr-only">{needs ? "Needs review" : "Reviewed"}</span>
          ) : needs ? (
            "Needs review"
          ) : (
            "Reviewed"
          )}
        </span>
      )}
      {cite ? (
        <button
          type="button"
          onClick={() => showCitation(path)}
          aria-label={`Show contract citation for ${pathLabel(path)}${cite.page != null ? `, page ${cite.page}` : ""}`}
          className="inline-flex items-center gap-1 rounded-xs px-1 font-mono text-2xs text-accent-text hover:bg-accent-subtle"
        >
          <Quote className="size-3" aria-hidden />
          {!compact && (cite.page != null ? `p.${cite.page}` : "cited")}
        </button>
      ) : (
        <Tooltip content="No clause in the contract backs this value. Confirm it with the account team.">
          <button
            type="button"
            className={cn(
              "inline-flex cursor-help items-center gap-1 rounded-xs text-2xs text-ink-subtle",
              compact ? "size-3 justify-center rounded-full border border-dashed border-ink-subtle" : "",
            )}
          >
            {compact ? <span className="sr-only">No citation</span> : "No citation"}
          </button>
        </Tooltip>
      )}
    </span>
  );
}

/** A region tied to a policy path: focus or hover highlights its citation. */
function Linked({ path, children, className }: { path: string; children: ReactNode; className?: string }) {
  const { activate, activePath, unresolved, issues } = useReview();
  const active = activePath === path;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover only mirrors the keyboard focus highlight
    <div
      id={fieldDomId(path)}
      data-path={path}
      onFocusCapture={() => activate(path, "focus")}
      onMouseEnter={() => activate(path, "hover")}
      onMouseLeave={() => activate(null, "hover")}
      className={cn(
        "scroll-mt-24 rounded-md transition-[background-color,box-shadow] duration-[var(--duration-base)]",
        active && "bg-accent-subtle/45 ring-1 ring-accent/40",
        !active && unresolved.has(path) && "bg-warning-subtle/50 ring-1 ring-warning-border",
        !active && issues.has(path) && "ring-1 ring-breached-border",
        className,
      )}
    >
      {children}
    </div>
  );
}

function IssueText({ path }: { path: string }) {
  const { issues } = useReview();
  const msg = issues.get(path);
  if (!msg) return null;
  return (
    <p role="alert" className="mt-1 flex items-center gap-1 text-xs font-medium text-breached-text">
      <CircleAlert className="size-3.5 shrink-0" aria-hidden />
      {msg}
    </p>
  );
}

function Section({
  title,
  description,
  children,
  aside,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <Card>
      <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-3.5">
        <div>
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          {description && <p className="mt-0.5 text-xs text-ink-muted">{description}</p>}
        </div>
        {aside}
      </div>
      <div className="p-5">{children}</div>
    </Card>
  );
}

function RowLabel({ path, children, htmlFor }: { path: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="mb-1.5 flex items-center justify-between gap-2">
      <Label htmlFor={htmlFor}>{children}</Label>
      <CitationMarker path={path} />
    </div>
  );
}

const numberOrNaN = (s: string) => (s.trim() === "" ? Number.NaN : Number(s));
const shown = (n: number) => (Number.isFinite(n) ? String(n) : "");

// ---------------------------------------------------------------- basics

function BasicsSection({ value, update }: { value: SlaPolicy; update: Update }) {
  const { readOnly } = useReview();
  return (
    <Section title="Policy" description="How tickets are prioritised and when slai starts warning.">
      <div className="grid gap-4 md:grid-cols-2">
        <div className="md:col-span-2">
          <Label htmlFor="policy-name" className="mb-1.5 block">
            Policy name
          </Label>
          <Input
            id="policy-name"
            value={value.name}
            disabled={readOnly}
            onChange={(e) =>
              update((d) => {
                d.name = e.target.value;
              })
            }
          />
        </div>
        <Linked path="defaultPriority" className="p-2 -m-2">
          <RowLabel path="defaultPriority" htmlFor="default-priority">
            Priority when a ticket has none
          </RowLabel>
          <Select
            id="default-priority"
            value={value.defaultPriority ?? "none"}
            disabled={readOnly}
            onValueChange={(v) =>
              update((d) => {
                d.defaultPriority = v === "none" ? null : (v as Priority);
              })
            }
            options={[
              ...PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] })),
              { value: "none", label: "Don't measure until set" },
            ]}
            className="w-full"
          />
        </Linked>
        <Linked path="warnAt" className="p-2 -m-2">
          <RowLabel path="warnAt">Warning thresholds</RowLabel>
          <div className="flex items-center gap-2">
            {[0, 1].map((i) => (
              <Input
                key={i}
                type="number"
                min={1}
                max={99}
                aria-label={i === 0 ? "Warning at percent of target" : "At risk at percent of target"}
                value={value.warnAt[i] !== undefined ? shown(Math.round(value.warnAt[i]! * 100)) : ""}
                disabled={readOnly}
                onChange={(e) =>
                  update((d) => {
                    d.warnAt[i] = numberOrNaN(e.target.value) / 100;
                  })
                }
                trailing="%"
                className="w-24"
              />
            ))}
            <span className="text-xs text-ink-muted">warning, then at risk</span>
          </div>
          <IssueText path="warnAt" />
        </Linked>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------- calendar

const ALL_DAY = [{ start: "00:00", end: "24:00" }];

function timezones(current: string) {
  let zones: string[] = [];
  try {
    zones = Intl.supportedValuesOf("timeZone");
  } catch {
    zones = ["UTC", "Europe/London", "America/New_York", "America/Chicago", "America/Los_Angeles"];
  }
  if (!zones.includes(current)) zones = [current, ...zones];
  return zones.map((z) => ({ value: z, label: z.replace(/_/g, " ") }));
}

function CalendarSection({ value, update }: { value: SlaPolicy; update: Update }) {
  const { readOnly } = useReview();
  const zones = useMemo(() => timezones(value.calendar.timezone), [value.calendar.timezone]);
  const weekly = value.calendar.weekly;
  const is247 = WEEKDAYS.every((d) => JSON.stringify(weekly[d] ?? []) === JSON.stringify(ALL_DAY));
  const [holiday, setHoliday] = useState("");

  return (
    <Section
      title="Business calendar"
      description="Business-clock targets only count time inside these hours, in this time zone."
    >
      <div className="flex flex-col gap-5">
        <Linked path="calendar.timezone" className="p-2 -m-2">
          <RowLabel path="calendar.timezone" htmlFor="calendar-tz">
            Time zone
          </RowLabel>
          <Select
            id="calendar-tz"
            value={value.calendar.timezone}
            disabled={readOnly}
            onValueChange={(v) =>
              update((d) => {
                d.calendar.timezone = v;
              })
            }
            options={zones}
            className="w-full md:w-80"
          />
          <IssueText path="calendar.timezone" />
        </Linked>

        <Linked path="calendar.weekly" className="p-2 -m-2">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-medium text-ink">Weekly hours</span>
            <div className="flex items-center gap-3">
              <CitationMarker path="calendar.weekly" />
              <span className="inline-flex items-center gap-2 text-xs text-ink-muted">
                <Switch
                  aria-label="Open 24×7"
                  checked={is247}
                  disabled={readOnly}
                  onCheckedChange={(on) =>
                    update((d) => {
                      d.calendar.weekly = on
                        ? Object.fromEntries(WEEKDAYS.map((w) => [w, structuredClone(ALL_DAY)]))
                        : Object.fromEntries(WEEKDAYS.slice(0, 5).map((w) => [w, [{ start: "09:00", end: "17:00" }]]));
                    })
                  }
                />
                <span aria-hidden>24×7</span>
              </span>
            </div>
          </div>
          <ul className="divide-y divide-line rounded-md border border-line bg-surface">
            {WEEKDAYS.map((day) => (
              <DayRow key={day} day={day} ranges={weekly[day] ?? []} update={update} readOnly={readOnly} />
            ))}
          </ul>
          <IssueText path="calendar.weekly" />
        </Linked>

        <Linked path="calendar.holidays" className="p-2 -m-2">
          <RowLabel path="calendar.holidays" htmlFor="holiday-new">
            Holidays
          </RowLabel>
          <div className="flex flex-wrap gap-1.5">
            {value.calendar.holidays.length === 0 && <span className="text-xs text-ink-muted">No holidays.</span>}
            {[...value.calendar.holidays].sort().map((h) => (
              <span
                key={h}
                className="inline-flex h-6 items-center gap-1 rounded-sm border border-line bg-sunken pr-0.5 pl-2 font-mono text-xs text-ink tnum"
              >
                {new Date(`${h}T12:00:00Z`).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
                {!readOnly && (
                  <button
                    type="button"
                    aria-label={`Remove holiday ${h}`}
                    onClick={() =>
                      update((d) => {
                        d.calendar.holidays = d.calendar.holidays.filter((x) => x !== h);
                      })
                    }
                    className="inline-flex size-5 items-center justify-center rounded-xs text-ink-subtle hover:bg-hover hover:text-ink"
                  >
                    <X className="size-3" aria-hidden />
                  </button>
                )}
              </span>
            ))}
          </div>
          {!readOnly && (
            <form
              className="mt-2 flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (!/^\d{4}-\d{2}-\d{2}$/.test(holiday)) return;
                update((d) => {
                  if (!d.calendar.holidays.includes(holiday)) d.calendar.holidays.push(holiday);
                });
                setHoliday("");
              }}
            >
              <Input
                id="holiday-new"
                type="date"
                inputSize="sm"
                aria-label="Holiday date"
                value={holiday}
                onChange={(e) => setHoliday(e.target.value)}
                className="w-40"
              />
              <Button size="sm" type="submit" disabled={!holiday} leadingIcon={<Plus />}>
                Add holiday
              </Button>
            </form>
          )}
          <IssueText path="calendar.holidays" />
        </Linked>
      </div>
    </Section>
  );
}

function DayRow({
  day,
  ranges,
  update,
  readOnly,
}: {
  day: Weekday;
  ranges: { start: string; end: string }[];
  update: Update;
  readOnly: boolean;
}) {
  const working = ranges.length > 0;
  const setRanges = (next: { start: string; end: string }[]) =>
    update((d) => {
      d.calendar.weekly[day] = next;
    });
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2">
      <span className="flex w-32 items-center gap-2 text-sm text-ink">
        <Switch
          checked={working}
          disabled={readOnly}
          onCheckedChange={(on) => setRanges(on ? [{ start: "09:00", end: "17:00" }] : [])}
          aria-label={`${WEEKDAY_LABEL[day]} is a working day`}
        />
        <span aria-hidden>{WEEKDAY_LABEL[day].slice(0, 3)}</span>
      </span>
      {!working && <span className="text-xs text-ink-subtle">Closed</span>}
      <div className="flex flex-wrap items-center gap-2">
        {ranges.map((r, i) => {
          const allDay = r.start === "00:00" && r.end === "24:00";
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: ranges are positional
            <span key={i} className="inline-flex items-center gap-1">
              {allDay ? (
                <span className="inline-flex h-7 items-center rounded-sm bg-accent-subtle px-2 text-xs font-medium text-accent-text">
                  24 hours
                </span>
              ) : (
                <>
                  <Input
                    type="time"
                    inputSize="sm"
                    aria-label={`${WEEKDAY_LABEL[day]} range ${i + 1} start`}
                    value={r.start}
                    disabled={readOnly}
                    onChange={(e) => setRanges(ranges.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)))}
                    className="w-32 font-mono tnum"
                  />
                  <span className="text-ink-subtle" aria-hidden>
                    –
                  </span>
                  <Input
                    type="time"
                    inputSize="sm"
                    aria-label={`${WEEKDAY_LABEL[day]} range ${i + 1} end (00:00 means midnight)`}
                    value={r.end === "24:00" ? "00:00" : r.end}
                    disabled={readOnly}
                    onChange={(e) =>
                      setRanges(
                        ranges.map((x, j) =>
                          j === i ? { ...x, end: e.target.value === "00:00" ? "24:00" : e.target.value } : x,
                        ),
                      )
                    }
                    className="w-32 font-mono tnum"
                  />
                </>
              )}
              {!readOnly && (
                <IconButton
                  size="sm"
                  label={`Remove ${WEEKDAY_LABEL[day]} range ${i + 1}`}
                  icon={<X />}
                  onClick={() => setRanges(ranges.filter((_, j) => j !== i))}
                />
              )}
            </span>
          );
        })}
        {working && !readOnly && (
          <Button
            size="sm"
            variant="ghost"
            leadingIcon={<Plus />}
            onClick={() => setRanges([...ranges, { start: "13:00", end: "17:00" }])}
            aria-label={`Add a range on ${WEEKDAY_LABEL[day]}`}
          >
            Range
          </Button>
        )}
      </div>
    </li>
  );
}

// ---------------------------------------------------------------- targets

function TargetsSection({ value, update }: { value: SlaPolicy; update: Update }) {
  const { readOnly } = useReview();
  const measured = value.targets.length;
  return (
    <Section
      title="Targets"
      description="Minutes per metric and priority. Leave a cell empty when the contract doesn't measure it."
      aside={<span className="font-mono text-xs text-ink-muted tnum">{measured} of 16 measured</span>}
    >
      <div className="-mx-5 overflow-x-auto px-5 scrollbar-thin">
        <table className="w-full min-w-[620px] border-separate border-spacing-1.5 text-sm">
          <caption className="sr-only">Targets by metric and priority</caption>
          <thead>
            <tr>
              <th scope="col" className="w-36 text-left text-2xs font-semibold tracking-wide text-ink-muted uppercase">
                Metric
              </th>
              {PRIORITIES.map((p) => (
                <th
                  key={p}
                  scope="col"
                  className="text-left text-2xs font-semibold tracking-wide text-ink-muted uppercase"
                >
                  {PRIORITY_LABEL[p]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {METRICS.map((m) => (
              <tr key={m}>
                <th scope="row" className="pr-2 text-left align-top text-sm font-medium text-ink">
                  <span className="block pt-1.5">{METRIC_LABEL[m]}</span>
                </th>
                {PRIORITIES.map((p) => (
                  <td key={p} className="align-top">
                    <TargetCell value={value} metric={m} priority={p} update={update} readOnly={readOnly} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

function TargetCell({
  value,
  metric,
  priority,
  update,
  readOnly,
}: {
  value: SlaPolicy;
  metric: Metric;
  priority: Priority;
  update: Update;
  readOnly: boolean;
}) {
  const path = targetPath(metric, priority);
  const { issues } = useReview();
  const target = value.targets.find((t) => t.metric === metric && t.priority === priority);
  const label = `${METRIC_LABEL[metric]}, ${PRIORITY_LABEL[priority]}, minutes`;
  const setMinutes = (raw: string) =>
    update((d) => {
      const i = d.targets.findIndex((t) => t.metric === metric && t.priority === priority);
      if (raw.trim() === "") {
        if (i >= 0) d.targets.splice(i, 1);
        return;
      }
      const minutes = Number(raw);
      if (i >= 0) d.targets[i]!.minutes = minutes;
      else d.targets.push({ metric, priority, minutes, clock: "business" });
    });
  return (
    <Linked path={path} className={cn("p-1.5", target ? "bg-surface" : "bg-sunken/50")}>
      <div className="flex items-center gap-1">
        <Input
          type="number"
          inputSize="sm"
          min={1}
          step={1}
          aria-label={label}
          aria-invalid={issues.has(path) || undefined}
          placeholder="—"
          value={target ? shown(target.minutes) : ""}
          disabled={readOnly}
          onChange={(e) => setMinutes(e.target.value)}
          className="w-full min-w-0"
        />
        <CitationMarker path={path} compact />
      </div>
      <div className="mt-1 flex items-center justify-between gap-1 text-2xs">
        <span className="font-mono text-ink-muted tnum">
          {target && Number.isFinite(target.minutes) && target.minutes > 0
            ? formatDuration(target.minutes * 60_000)
            : "not measured"}
        </span>
        {target && (
          <button
            type="button"
            disabled={readOnly}
            onClick={() =>
              update((d) => {
                const t = d.targets.find((x) => x.metric === metric && x.priority === priority);
                if (t) t.clock = t.clock === "business" ? "calendar" : "business";
              })
            }
            aria-label={`${METRIC_LABEL[metric]}, ${PRIORITY_LABEL[priority]}: ${target.clock === "business" ? "business hours" : "calendar (24×7)"} clock. Switch.`}
            className={cn(
              "rounded-xs px-1 font-medium",
              target.clock === "calendar" ? "bg-accent-subtle text-accent-text" : "text-ink-muted hover:bg-hover",
            )}
          >
            {target.clock === "business" ? "business" : "24×7"}
          </button>
        )}
      </div>
      {issues.has(path) && <span className="sr-only">{issues.get(path)}</span>}
    </Linked>
  );
}

// ---------------------------------------------------------------- pauses

const PAUSABLE: TicketStatus[] = ["new", "open", "pending", "on_hold"];
const PAUSE_LABEL: Record<string, string> = { new: "New", open: "Open", pending: "Pending", on_hold: "On hold" };

function PausesSection({ value, update }: { value: SlaPolicy; update: Update }) {
  const { readOnly } = useReview();
  return (
    <Section
      title="Pauses"
      description="A metric's clock stops while the ticket is in a checked status (e.g. waiting on the customer)."
    >
      <div className="-mx-5 overflow-x-auto px-5 scrollbar-thin">
        <table className="w-full min-w-[520px] text-sm">
          <caption className="sr-only">Statuses that pause each metric</caption>
          <thead>
            <tr>
              <th scope="col" className="pb-2 text-left text-2xs font-semibold tracking-wide text-ink-muted uppercase">
                Metric
              </th>
              {PAUSABLE.map((s) => (
                <th
                  key={s}
                  scope="col"
                  className="pb-2 text-center text-2xs font-semibold tracking-wide text-ink-muted uppercase"
                >
                  {PAUSE_LABEL[s]}
                </th>
              ))}
              <th scope="col" className="w-24 pb-2">
                <span className="sr-only">Citation</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {METRICS.map((m) => {
              const list = value.pauseStatuses[m] ?? [];
              const path = `pauseStatuses.${m}`;
              return (
                <tr key={m} id={fieldDomId(path)} className="scroll-mt-24">
                  <th scope="row" className="py-1 text-left font-medium text-ink" colSpan={1}>
                    {METRIC_LABEL[m]}
                  </th>
                  {PAUSABLE.map((s) => (
                    <td key={s} className="py-1 text-center">
                      <PauseCell path={path}>
                        <Checkbox
                          aria-label={`Pause ${METRIC_LABEL[m]} while ${PAUSE_LABEL[s]}`}
                          checked={list.includes(s)}
                          disabled={readOnly}
                          onCheckedChange={(on) =>
                            update((d) => {
                              const cur = new Set(d.pauseStatuses[m] ?? []);
                              if (on) cur.add(s);
                              else cur.delete(s);
                              const next = PAUSABLE.filter((x) => cur.has(x));
                              if (next.length) d.pauseStatuses[m] = next;
                              else delete d.pauseStatuses[m];
                            })
                          }
                        />
                      </PauseCell>
                    </td>
                  ))}
                  <td className="py-1 text-right">{list.length > 0 && <CitationMarker path={path} />}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {METRICS.map((m) => (
        <IssueText key={m} path={`pauseStatuses.${m}`} />
      ))}
    </Section>
  );
}

function PauseCell({ path, children }: { path: string; children: ReactNode }) {
  const { activate, activePath, unresolved } = useReview();
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover only mirrors the keyboard focus highlight
    <span
      onFocusCapture={() => activate(path, "focus")}
      onMouseEnter={() => activate(path, "hover")}
      onMouseLeave={() => activate(null, "hover")}
      className={cn(
        "inline-flex size-8 items-center justify-center rounded-md transition-colors",
        activePath === path && "bg-accent-subtle",
        activePath !== path && unresolved.has(path) && "bg-warning-subtle",
      )}
    >
      {children}
    </span>
  );
}

// ---------------------------------------------------------------- credits

function AmountInput({
  amount,
  onChange,
  readOnly,
  label,
}: {
  amount: CreditAmount;
  onChange: (a: CreditAmount) => void;
  readOnly: boolean;
  label: string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <Input
        type="number"
        inputSize="sm"
        min={0}
        step={amount.kind === "fixed_cents" ? 1 : 0.5}
        aria-label={`${label} value`}
        value={amount.kind === "fixed_cents" ? shown(amount.cents / 100) : shown(amount.percent)}
        disabled={readOnly}
        onChange={(e) => {
          const n = numberOrNaN(e.target.value);
          onChange(
            amount.kind === "fixed_cents"
              ? { kind: "fixed_cents", cents: Math.round(n * 100) }
              : { kind: "percent_of_fee", percent: n },
          );
        }}
        leading={amount.kind === "fixed_cents" ? <span className="text-xs">$</span> : undefined}
        className="w-28"
      />
      <div className="w-40 shrink-0">
        <Select
          size="sm"
          aria-label={`${label} unit`}
          value={amount.kind}
          disabled={readOnly}
          onValueChange={(k) =>
            onChange(k === "fixed_cents" ? { kind: "fixed_cents", cents: 0 } : { kind: "percent_of_fee", percent: 5 })
          }
          options={[
            { value: "percent_of_fee", label: "% of monthly fee" },
            { value: "fixed_cents", label: "USD fixed" },
          ]}
        />
      </div>
    </div>
  );
}

function CreditsSection({ value, update }: { value: SlaPolicy; update: Update }) {
  const { readOnly } = useReview();
  const setCredit = (id: string, mutate: (c: CreditRule) => void) =>
    update((d) => {
      const c = d.credits.find((x) => x.id === id);
      if (c) mutate(c);
    });
  return (
    <Section
      title="Service credits"
      description="What a breach costs. Drives dollar exposure on the dashboard and in Breach Replay."
      aside={
        !readOnly && (
          <Button
            size="sm"
            leadingIcon={<Plus />}
            onClick={() =>
              update((d) =>
                d.credits.push({
                  id: `cr_${Math.random().toString(36).slice(2, 8)}`,
                  basis: "per_breach",
                  metric: null,
                  priority: null,
                  amount: { kind: "percent_of_fee", percent: 5 },
                  capPercent: null,
                  sourceClause: null,
                }),
              )
            }
          >
            Add credit
          </Button>
        )
      }
    >
      {value.credits.length === 0 && (
        <p className="text-sm text-ink-muted">No service credits. Breaches carry no dollar exposure.</p>
      )}
      <div className="flex flex-col gap-3">
        {value.credits.map((c) => {
          const path = `credits.${c.id}`;
          return (
            <Linked key={c.id} path={path} className="border border-line p-3">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-ink">
                    {c.basis === "per_breach" ? "Per breach" : "Attainment tiers"}
                  </span>
                  {c.sourceClause && <span className="font-mono text-2xs text-ink-muted">{c.sourceClause}</span>}
                </div>
                <div className="flex items-center gap-1">
                  <CitationMarker path={path} />
                  {!readOnly && (
                    <IconButton
                      size="sm"
                      label="Remove credit"
                      icon={<Trash2 />}
                      onClick={() =>
                        update((d) => {
                          d.credits = d.credits.filter((x) => x.id !== c.id);
                        })
                      }
                    />
                  )}
                </div>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <span className="mb-1 block text-xs font-medium text-ink-muted">Applies to</span>
                  <div className="flex gap-1.5">
                    <Select
                      size="sm"
                      aria-label="Credit metric"
                      value={c.metric ?? "any"}
                      disabled={readOnly}
                      onValueChange={(v) =>
                        setCredit(c.id, (x) => {
                          x.metric = v === "any" ? null : (v as Metric);
                        })
                      }
                      options={[
                        { value: "any", label: "Any metric" },
                        ...METRICS.map((m) => ({ value: m, label: METRIC_LABEL[m] })),
                      ]}
                    />
                    <Select
                      size="sm"
                      aria-label="Credit priority"
                      value={c.priority ?? "any"}
                      disabled={readOnly}
                      onValueChange={(v) =>
                        setCredit(c.id, (x) => {
                          x.priority = v === "any" ? null : (v as Priority);
                        })
                      }
                      options={[
                        { value: "any", label: "Any priority" },
                        ...PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] })),
                      ]}
                    />
                  </div>
                </div>
                <div>
                  <span className="mb-1 block text-xs font-medium text-ink-muted">Cap per period</span>
                  <Input
                    type="number"
                    inputSize="sm"
                    min={1}
                    max={100}
                    aria-label="Cap as percent of monthly fee"
                    placeholder="No cap"
                    value={c.capPercent === null ? "" : shown(c.capPercent)}
                    disabled={readOnly}
                    onChange={(e) =>
                      setCredit(c.id, (x) => {
                        x.capPercent = e.target.value.trim() === "" ? null : Number(e.target.value);
                      })
                    }
                    trailing="% of fee"
                    className="w-40"
                  />
                </div>
              </div>
              {c.basis === "per_breach" ? (
                <div className="mt-3">
                  <span className="mb-1 block text-xs font-medium text-ink-muted">Credit per breached cycle</span>
                  <AmountInput
                    label="Per-breach credit"
                    amount={c.amount}
                    readOnly={readOnly}
                    onChange={(a) =>
                      setCredit(c.id, (x) => {
                        if (x.basis === "per_breach") x.amount = a;
                      })
                    }
                  />
                </div>
              ) : (
                <div className="mt-3 flex flex-col gap-2">
                  <span className="block text-xs font-medium text-ink-muted">When monthly attainment falls below…</span>
                  {c.tiers.map((tier, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: tiers are positional
                    <div key={i} className="flex flex-wrap items-center gap-1.5">
                      <Input
                        type="number"
                        inputSize="sm"
                        min={1}
                        max={100}
                        step={0.1}
                        aria-label={`Tier ${i + 1} attainment threshold`}
                        value={shown(tier.belowPercent)}
                        disabled={readOnly}
                        onChange={(e) =>
                          setCredit(c.id, (x) => {
                            if (x.basis === "attainment" && x.tiers[i])
                              x.tiers[i].belowPercent = numberOrNaN(e.target.value);
                          })
                        }
                        trailing="%"
                        className="w-24"
                      />
                      <span className="text-xs text-ink-muted" aria-hidden>
                        →
                      </span>
                      <AmountInput
                        label={`Tier ${i + 1} credit`}
                        amount={tier.amount}
                        readOnly={readOnly}
                        onChange={(a) =>
                          setCredit(c.id, (x) => {
                            if (x.basis === "attainment" && x.tiers[i]) x.tiers[i].amount = a;
                          })
                        }
                      />
                      {!readOnly && c.tiers.length > 1 && (
                        <IconButton
                          size="sm"
                          label={`Remove tier ${i + 1}`}
                          icon={<X />}
                          onClick={() =>
                            setCredit(c.id, (x) => {
                              if (x.basis === "attainment") x.tiers.splice(i, 1);
                            })
                          }
                        />
                      )}
                    </div>
                  ))}
                  {!readOnly && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="self-start"
                      leadingIcon={<Plus />}
                      onClick={() =>
                        setCredit(c.id, (x) => {
                          if (x.basis === "attainment") {
                            const last = x.tiers[x.tiers.length - 1];
                            x.tiers.push({
                              belowPercent: Math.max(1, (last?.belowPercent ?? 95) - 5),
                              amount: { kind: "percent_of_fee", percent: 10 },
                            });
                          }
                        })
                      }
                    >
                      Add tier
                    </Button>
                  )}
                </div>
              )}
              <IssueText path={path} />
            </Linked>
          );
        })}
      </div>
    </Section>
  );
}
