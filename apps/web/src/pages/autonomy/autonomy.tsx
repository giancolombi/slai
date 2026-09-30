import type { Autonomy, AutonomyRule, CustomerAccount, Priority } from "@slai/shared";
import { autonomyRuleBody } from "@slai/shared";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  cn,
  Dialog,
  Field,
  RISK_META,
  SegmentedControl,
  Skeleton,
  Table,
  TBody,
  TD,
  TH,
  THead,
  Tooltip,
  TR,
  toast,
} from "@slai/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Bell, Eye, Gauge, Lock, PenLine, ShieldCheck, UserCheck, Zap } from "lucide-react";
import { useId, useState } from "react";
import { ErrorState, Page } from "../../components/page";
import { api, errorMessage } from "../../lib/api";
import { AUTONOMY_HELP, AUTONOMY_LABEL, PRIORITIES, PRIORITY_LABEL } from "../../lib/labels";
import { qk, useAutonomy, useCustomers, useMe } from "../../lib/queries";
import { exactRule, type RuleSource, resolveRule } from "./resolve";

const LEVEL_ICON: Record<Autonomy, typeof Eye> = { observe: Eye, assist: PenLine, autopilot: Zap };

const LEVEL_DETAILS: Record<Autonomy, { can: string[]; human: string }> = {
  observe: {
    can: ["Watches every clock", "Alerts in-app, email and Slack", "Never touches the ticket"],
    human: "Your team does all the work.",
  },
  assist: {
    can: ["Triages category and priority", "Drafts a reply in a sandbox", "Posts it as an internal note"],
    human: "A person approves every reply in one click.",
  },
  autopilot: {
    can: ["Everything in Assist", "Sends the reply when guardrails pass", "Blocks pricing, legal and policy promises"],
    human: "Drafts below the confidence floor go to a person.",
  },
};

const levelChip: Record<Autonomy, string> = {
  observe: "bg-sunken text-ink-muted border-line-strong",
  assist: "bg-accent-subtle text-accent-text border-accent/25",
  autopilot: "bg-accent text-on-accent border-accent",
};

function LevelChip({ level, inherited }: { level: Autonomy; inherited?: boolean }) {
  const Icon = LEVEL_ICON[level];
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-1 rounded-sm border px-2 text-xs font-medium whitespace-nowrap [&_svg]:size-3.5",
        inherited ? "border-dashed border-line-strong bg-transparent text-ink-muted" : levelChip[level],
      )}
    >
      <Icon aria-hidden />
      {AUTONOMY_LABEL[level]}
    </span>
  );
}

function sourceText(source: RuleSource, customerName: string | null, priority: Priority | null) {
  switch (source) {
    case "customer":
      return `Inherited from ${customerName ?? "this customer"}'s rule for any priority`;
    case "priority":
      return `Inherited from the ${priority ? PRIORITY_LABEL[priority].toLowerCase() : ""} rule for all customers`;
    case "default":
      return "Inherited from the default rule";
    case "none":
      return "No rule applies: slai only observes";
    default:
      return "Set here";
  }
}

interface Scope {
  customer: CustomerAccount | null;
  priority: Priority | null;
}

function RuleDialog({
  scope,
  rules,
  onClose,
  canEdit,
}: {
  scope: Scope;
  rules: AutonomyRule[];
  onClose: () => void;
  canEdit: boolean;
}) {
  const queryClient = useQueryClient();
  const customerId = scope.customer?.id ?? null;
  const existing = exactRule(rules, customerId, scope.priority);
  const inherited = resolveRule(rules, customerId, scope.priority).rule;
  const start = existing ?? inherited;
  const [level, setLevel] = useState<Autonomy>(start?.level ?? "observe");
  const [triggerAt, setTriggerAt] = useState<AutonomyRule["triggerAt"]>(start?.triggerAt ?? "at_risk");
  const [confidence, setConfidence] = useState(Math.round((start?.minConfidence ?? 0.8) * 100));
  const confId = useId();
  const isDefault = customerId === null && scope.priority === null;

  const done = (title: string) => {
    queryClient.invalidateQueries({ queryKey: qk.autonomy });
    toast({ tone: "success", title });
    onClose();
  };
  const save = useMutation({
    mutationFn: () => {
      const body = autonomyRuleBody.parse({
        customerAccountId: customerId,
        priority: scope.priority,
        level,
        triggerAt,
        minConfidence: confidence / 100,
      });
      return existing ? api.autonomy.update(existing.id, body) : api.autonomy.create(body);
    },
    onSuccess: () => done("Autonomy rule saved"),
    onError: (e) => toast({ tone: "error", title: "Couldn't save the rule", description: errorMessage(e) }),
  });
  const remove = useMutation({
    mutationFn: () => api.autonomy.remove(existing!.id),
    onSuccess: () => done("Rule removed; this scope inherits again"),
    onError: (e) => toast({ tone: "error", title: "Couldn't remove the rule", description: errorMessage(e) }),
  });

  const scopeLabel = `${scope.customer?.name ?? "All customers"} · ${scope.priority ? PRIORITY_LABEL[scope.priority] : "Any priority"}`;

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={existing ? "Edit autonomy rule" : "Add an autonomy rule"}
      description={scopeLabel}
      footer={
        canEdit ? (
          <>
            {existing && !isDefault && (
              <Button
                variant="ghost"
                className="mr-auto text-breached-text"
                loading={remove.isPending}
                onClick={() => remove.mutate()}
              >
                Remove rule
              </Button>
            )}
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
              {existing ? "Save rule" : "Add rule"}
            </Button>
          </>
        ) : (
          <Button onClick={onClose}>Close</Button>
        )
      }
    >
      <div className="flex flex-col gap-5">
        {!existing && inherited && (
          <p className="rounded-md border border-line bg-sunken/60 px-3 py-2 text-xs text-ink-muted">
            This scope currently inherits <strong className="text-ink">{AUTONOMY_LABEL[inherited.level]}</strong>.
            Saving creates a rule for exactly this scope, which wins over broader rules.
          </p>
        )}
        <fieldset className="flex flex-col gap-2" disabled={!canEdit}>
          <legend className="mb-1.5 text-sm font-medium text-ink">Level</legend>
          <SegmentedControl
            aria-label="Autonomy level"
            value={level}
            onValueChange={(v) => setLevel(v as Autonomy)}
            options={(["observe", "assist", "autopilot"] as const).map((l) => {
              const Icon = LEVEL_ICON[l];
              return {
                value: l,
                label: (
                  <>
                    <Icon aria-hidden /> {AUTONOMY_LABEL[l]}
                  </>
                ),
                ariaLabel: AUTONOMY_LABEL[l],
              };
            })}
            className="self-start"
          />
          <p className="text-xs leading-relaxed text-ink-muted">{AUTONOMY_HELP[level]}</p>
        </fieldset>
        <fieldset className="flex flex-col gap-2" disabled={!canEdit}>
          <legend className="mb-1.5 text-sm font-medium text-ink">Dispatch agents when a ticket reaches</legend>
          <SegmentedControl
            aria-label="Trigger risk"
            value={triggerAt}
            onValueChange={(v) => setTriggerAt(v as AutonomyRule["triggerAt"])}
            options={(["warning", "at_risk", "breached"] as const).map((r) => {
              const Icon = RISK_META[r].icon;
              return {
                value: r,
                label: (
                  <>
                    <Icon aria-hidden className={RISK_META[r].text} /> {RISK_META[r].label}
                  </>
                ),
                ariaLabel: RISK_META[r].label,
              };
            })}
            className="self-start"
          />
          <p className="text-xs text-ink-muted">Earlier triggers buy more time; later triggers spend fewer credits.</p>
        </fieldset>
        <Field
          label="Minimum confidence"
          hint={
            level === "autopilot"
              ? "Drafts below this confidence are never sent automatically; they wait for a person."
              : "Drafts below this confidence are discarded instead of queued."
          }
          id={confId}
        >
          <div className="flex items-center gap-3">
            <input
              id={confId}
              type="range"
              min={50}
              max={99}
              step={1}
              value={confidence}
              disabled={!canEdit}
              onChange={(e) => setConfidence(Number(e.target.value))}
              className="h-1.5 flex-1 cursor-pointer accent-[var(--accent)]"
              aria-valuetext={`${confidence}%`}
            />
            <output htmlFor={confId} className="w-12 text-right font-mono text-sm text-ink tnum">
              {confidence}%
            </output>
          </div>
        </Field>
      </div>
    </Dialog>
  );
}

function Explainers() {
  return (
    <div className="grid gap-4 md:grid-cols-3">
      {(["observe", "assist", "autopilot"] as const).map((l) => {
        const Icon = LEVEL_ICON[l];
        const d = LEVEL_DETAILS[l];
        return (
          <Card key={l} className="flex flex-col p-5">
            <div className="flex items-center gap-2.5">
              <span
                className={cn(
                  "inline-flex size-8 items-center justify-center rounded-md border [&_svg]:size-4",
                  levelChip[l],
                )}
              >
                <Icon aria-hidden />
              </span>
              <h2 className="text-md font-semibold text-ink">{AUTONOMY_LABEL[l]}</h2>
            </div>
            <p className="mt-3 text-sm leading-relaxed text-ink-muted">{AUTONOMY_HELP[l]}</p>
            <ul className="mt-3 flex flex-col gap-1.5 text-sm text-ink">
              {d.can.map((c) => (
                <li key={c} className="flex items-start gap-2">
                  <span aria-hidden className="mt-2 size-1 shrink-0 rounded-full bg-ink-subtle" />
                  {c}
                </li>
              ))}
            </ul>
            <p className="mt-auto flex items-center gap-1.5 pt-4 text-xs font-medium text-ink-muted">
              <UserCheck className="size-3.5" aria-hidden /> {d.human}
            </p>
          </Card>
        );
      })}
    </div>
  );
}

export function AutonomyPage() {
  const rulesQuery = useAutonomy();
  const customersQuery = useCustomers();
  const me = useMe();
  const canEdit = me.data ? ["owner", "admin"].includes(me.data.role) : false;
  const [scope, setScope] = useState<Scope | null>(null);

  const rows: (CustomerAccount | null)[] = [null, ...(customersQuery.data?.items ?? [])];
  const cols: (Priority | null)[] = [null, ...PRIORITIES];

  return (
    <Page
      title="Autonomy"
      description="Choose how much agents may do, per customer and priority. The SLA clock and alerts never depend on this."
    >
      <div className="flex flex-col gap-6">
        <Explainers />

        <Card>
          <CardHeader
            title="Rules"
            description={
              <>
                The most specific rule wins: customer + priority, then customer, then priority, then the default.{" "}
                <span className="mt-2 flex flex-wrap items-center gap-2">
                  <LevelChip level="assist" /> set for that scope
                  <LevelChip level="assist" inherited /> inherited from a broader rule
                </span>
              </>
            }
            actions={
              !canEdit && (
                <Badge tone="neutral" icon={<Lock aria-hidden />}>
                  Read-only: admins can edit
                </Badge>
              )
            }
          />
          <CardContent className="px-0 pb-0">
            {rulesQuery.isError || customersQuery.isError ? (
              <ErrorState
                error={rulesQuery.error ?? customersQuery.error}
                resource="autonomy rules"
                onRetry={() => {
                  rulesQuery.refetch();
                  customersQuery.refetch();
                }}
              />
            ) : rulesQuery.isPending || customersQuery.isPending ? (
              <div className="flex flex-col gap-2 px-5 pb-5" role="status" aria-label="Loading rules">
                {[0, 1, 2, 3, 4].map((i) => (
                  <Skeleton key={i} className="h-9" />
                ))}
              </div>
            ) : (
              <Table aria-label="Autonomy by customer and priority" containerClassName="border-t border-line">
                <THead>
                  <tr>
                    <TH className="w-[26%] pl-5">Customer</TH>
                    {cols.map((p) => (
                      <TH key={p ?? "any"}>{p ? PRIORITY_LABEL[p] : "Any priority"}</TH>
                    ))}
                  </tr>
                </THead>
                <TBody>
                  {rows.map((customer) => (
                    <TR key={customer?.id ?? "default"} className={customer === null ? "bg-sunken/40" : undefined}>
                      <TD className="pl-5">
                        <span className="font-medium">{customer?.name ?? "All customers"}</span>
                        {customer === null && (
                          <span className="block text-xs text-ink-muted">Default for everyone</span>
                        )}
                      </TD>
                      {cols.map((priority) => {
                        const { rule, source } = resolveRule(rulesQuery.data, customer?.id ?? null, priority);
                        const explicit = source === "exact";
                        const text = sourceText(source, customer?.name ?? null, priority);
                        const label = `${customer?.name ?? "All customers"}, ${priority ? PRIORITY_LABEL[priority] : "any priority"}: ${
                          rule ? AUTONOMY_LABEL[rule.level] : "Observe"
                        }. ${text}.${canEdit ? " Edit." : ""}`;
                        return (
                          <TD key={priority ?? "any"} className="py-2">
                            <Tooltip
                              content={
                                <span className="flex flex-col gap-0.5">
                                  <span>{text}</span>
                                  {rule && (
                                    <span className="opacity-80">
                                      Triggers at {RISK_META[rule.triggerAt].label.toLowerCase()} · min confidence{" "}
                                      {Math.round(rule.minConfidence * 100)}%
                                    </span>
                                  )}
                                </span>
                              }
                            >
                              <button
                                type="button"
                                aria-label={label}
                                onClick={() => setScope({ customer, priority })}
                                className="group -mx-1.5 flex flex-col items-start gap-1 rounded-md px-1.5 py-1 text-left hover:bg-hover"
                              >
                                <LevelChip level={rule?.level ?? "observe"} inherited={!explicit} />
                                {explicit && rule && (
                                  <span className="flex items-center gap-1 font-mono text-2xs whitespace-nowrap text-ink-muted tnum">
                                    <Bell className="size-3" aria-hidden />
                                    {RISK_META[rule.triggerAt].label} · {Math.round(rule.minConfidence * 100)}%
                                  </span>
                                )}
                              </button>
                            </Tooltip>
                          </TD>
                        );
                      })}
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <div className="grid gap-4 md:grid-cols-2">
          <Card className="flex gap-3 p-5">
            <ShieldCheck className="mt-0.5 size-5 shrink-0 text-accent-text" aria-hidden />
            <div>
              <h2 className="text-sm font-semibold text-ink">Guardrails on autopilot</h2>
              <p className="mt-1 text-sm text-ink-muted">
                A draft is only sent when it clears the confidence floor and makes no pricing, legal, refund or policy
                commitment. Anything else is blocked and queued in Approvals with the reason.
              </p>
            </div>
          </Card>
          <Card className="flex gap-3 p-5">
            <Gauge className="mt-0.5 size-5 shrink-0 text-accent-text" aria-hidden />
            <div>
              <h2 className="text-sm font-semibold text-ink">At the spend cap</h2>
              <p className="mt-1 text-sm text-ink-muted">
                Autonomy steps down: autopilot → assist → observe. The SLA clock and alerts are never throttled.
              </p>
            </div>
          </Card>
        </div>
      </div>

      {scope && rulesQuery.data && (
        <RuleDialog scope={scope} rules={rulesQuery.data} canEdit={canEdit} onClose={() => setScope(null)} />
      )}
    </Page>
  );
}
