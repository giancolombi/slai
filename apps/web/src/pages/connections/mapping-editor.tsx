import type { ConnectionMapping, FieldMappingTable, Priority, TicketStatus } from "@slai/shared";
import { Badge, Button, Card, CardHeader, cn, Dialog, Select, Table, TBody, TD, TH, THead, TR } from "@slai/ui";
import { CircleAlert, RotateCcw, Save } from "lucide-react";
import { useMemo, useState } from "react";
import { PRIORITIES, PRIORITY_LABEL, STATUS_LABEL, STATUSES } from "../../lib/labels";

type Field = "status" | "priority";

/** Select values: a canonical value, "use the default", or (priorities) "no priority". */
export const USE_DEFAULT = "__default";
export const NO_PRIORITY = "__none";

export interface MappingRow {
  field: Field;
  raw: string;
  /** The connector's default for this raw value; undefined when it has none. */
  defaultValue: string | null | undefined;
  /** The current choice: USE_DEFAULT, a canonical value, or NO_PRIORITY. */
  choice: string;
  /** Sync saw this value and nothing maps it (it counts as Open / no priority). */
  unmapped: boolean;
}

const encode = (field: Field, v: string | null) => (field === "priority" && v === null ? NO_PRIORITY : (v as string));

/** Every raw value worth showing: defaults, overrides, unmapped, and what tickets actually carry. */
export function mappingRows(m: ConnectionMapping, draft: FieldMappingTable = m.overrides): MappingRow[] {
  const rows: MappingRow[] = [];
  for (const field of ["status", "priority"] as const) {
    const unmapped = new Set(m.unmapped.filter((u) => u.field === field).map((u) => u.raw));
    const raws = new Set<string>([
      ...unmapped,
      ...m.observed[field],
      ...Object.keys(m.defaults[field]),
      ...Object.keys(draft[field]),
    ]);
    for (const raw of raws) {
      const defaults = m.defaults[field] as Record<string, string | null>;
      const chosen = draft[field] as Record<string, string | null>;
      const has = Object.hasOwn(chosen, raw);
      rows.push({
        field,
        raw,
        defaultValue: Object.hasOwn(defaults, raw) ? defaults[raw] : undefined,
        choice: has ? encode(field, chosen[raw] ?? null) : USE_DEFAULT,
        unmapped: unmapped.has(raw) && !has,
      });
    }
  }
  // Unmapped first, so what needs attention is on top.
  return rows.sort((a, b) => Number(b.unmapped) - Number(a.unmapped) || a.raw.localeCompare(b.raw));
}

/** The PUT body from the rows: only explicit choices are overrides (the API drops ones equal to defaults). */
export function toOverrides(rows: MappingRow[]): FieldMappingTable {
  const out: FieldMappingTable = { status: {}, priority: {} };
  for (const r of rows) {
    if (r.choice === USE_DEFAULT) continue;
    if (r.field === "status") out.status[r.raw] = r.choice as TicketStatus;
    else out.priority[r.raw] = r.choice === NO_PRIORITY ? null : (r.choice as Priority);
  }
  return out;
}

const label = (field: Field, v: string | null | undefined) =>
  v === undefined
    ? field === "status"
      ? "Unmapped (counts as Open)"
      : "Unmapped (policy default)"
    : v === null
      ? "No priority"
      : field === "status"
        ? STATUS_LABEL[v as TicketStatus]
        : PRIORITY_LABEL[v as Priority];

function optionsFor(row: MappingRow) {
  const canonical =
    row.field === "status"
      ? STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] }))
      : [
          ...PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] })),
          { value: NO_PRIORITY, label: "No priority" },
        ];
  return [{ value: USE_DEFAULT, label: `Default: ${label(row.field, row.defaultValue)}` }, ...canonical];
}

export interface MappingEditorProps {
  mapping: ConnectionMapping;
  /** Admins edit; everyone else reads. */
  canEdit: boolean;
  saving?: boolean;
  onSave: (overrides: FieldMappingTable) => void;
}

/**
 * Raw help-desk status/priority → slai's canonical values. Unmapped raw values
 * are highlighted; saving re-evaluates the connection's open tickets.
 */
export function MappingEditor({ mapping, canEdit, saving, onSave }: MappingEditorProps) {
  const [draft, setDraft] = useState<FieldMappingTable>(mapping.overrides);
  const [confirmReset, setConfirmReset] = useState(false);
  const rows = useMemo(() => mappingRows(mapping, draft), [mapping, draft]);
  const dirty = JSON.stringify(toOverrides(rows)) !== JSON.stringify(toOverrides(mappingRows(mapping)));
  const hasOverrides =
    Object.keys(mapping.overrides.status).length + Object.keys(mapping.overrides.priority).length > 0;
  const unmappedCount = rows.filter((r) => r.unmapped).length;

  const choose = (row: MappingRow, value: string) =>
    setDraft((d) => {
      const next: FieldMappingTable = { status: { ...d.status }, priority: { ...d.priority } };
      if (value === USE_DEFAULT) delete next[row.field][row.raw];
      else if (row.field === "status") next.status[row.raw] = value as TicketStatus;
      else next.priority[row.raw] = value === NO_PRIORITY ? null : (value as Priority);
      return next;
    });

  const section = (field: Field, title: string) => {
    const list = rows.filter((r) => r.field === field);
    return (
      <div>
        <h3 className="px-5 pb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">{title}</h3>
        <Table dense aria-label={`${title} mapping`}>
          <THead>
            <tr>
              <TH>In your help desk</TH>
              <TH>In slai</TH>
            </tr>
          </THead>
          <TBody>
            {list.map((row) => (
              <TR
                key={`${row.field}:${row.raw}`}
                data-unmapped={row.unmapped || undefined}
                className={cn(row.unmapped && "bg-warning-subtle/60")}
              >
                <TD className="w-1/2">
                  <span className="inline-flex items-center gap-2">
                    <code className="font-mono text-xs text-ink">{row.raw}</code>
                    {row.unmapped && (
                      <Badge tone="warning" size="sm" icon={<CircleAlert aria-hidden />}>
                        Unmapped
                      </Badge>
                    )}
                  </span>
                </TD>
                <TD>
                  {canEdit ? (
                    <Select
                      size="sm"
                      className="w-72"
                      aria-label={`slai ${field} for ${row.raw}`}
                      value={row.choice}
                      options={optionsFor(row)}
                      onValueChange={(v) => choose(row, v)}
                    />
                  ) : (
                    <span className="text-sm text-ink">
                      {row.choice === USE_DEFAULT
                        ? label(field, row.defaultValue)
                        : label(field, row.choice === NO_PRIORITY ? null : row.choice)}
                    </span>
                  )}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </div>
    );
  };

  return (
    <Card>
      <CardHeader
        title="Status and priority mapping"
        description="How this help desk's statuses and priorities read in slai. Pending and on-hold pause clocks your policy says to pause; unmapped statuses count as open, so clocks keep running."
        actions={
          canEdit ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                leadingIcon={<RotateCcw />}
                disabled={!hasOverrides || saving}
                onClick={() => setConfirmReset(true)}
              >
                Reset to default
              </Button>
              <Button
                size="sm"
                variant="primary"
                leadingIcon={<Save />}
                disabled={!dirty}
                loading={saving}
                onClick={() => onSave(toOverrides(rows))}
              >
                Save mapping
              </Button>
            </>
          ) : undefined
        }
      />
      {unmappedCount > 0 && (
        <p
          role="status"
          className="mx-5 mb-3 flex items-start gap-2 rounded-md border border-warning-border bg-warning-subtle px-3 py-2 text-sm text-warning-text"
        >
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          {unmappedCount === 1 ? "1 value needs" : `${unmappedCount} values need`} a mapping. Until then, those tickets
          count as open with the policy's default priority.
        </p>
      )}
      <div className="flex flex-col gap-5 pb-4">
        {section("status", "Statuses")}
        {section("priority", "Priorities")}
      </div>
      {!canEdit && <p className="px-5 pb-4 text-xs text-ink-muted">Only admins can change the mapping.</p>}
      <Dialog
        open={confirmReset}
        onOpenChange={setConfirmReset}
        size="sm"
        title="Reset to the default mapping?"
        description="Your changes are removed and slai's default mapping for this help desk applies. Open tickets are re-checked."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmReset(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={saving}
              onClick={() => {
                setConfirmReset(false);
                setDraft({ status: {}, priority: {} });
                onSave({ status: {}, priority: {} });
              }}
            >
              Reset mapping
            </Button>
          </>
        }
      />
    </Card>
  );
}
