import type { Policy, PolicyPreview, PolicyStatus } from "@slai/shared";
import {
  Badge,
  type BadgeTone,
  Button,
  Card,
  Dialog,
  EmptyState,
  formatDate,
  formatDateTime,
  formatMoney,
  formatNumber,
  formatPercent,
  Sheet,
  SkeletonRows,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  toast,
} from "@slai/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { Archive, ArrowRight, Gauge, ScrollText, Star } from "lucide-react";
import { useMemo, useState } from "react";
import { ErrorState, Page } from "../../components/page";
import { api, errorMessage } from "../../lib/api";
import { usePersonName } from "../../lib/people";
import { qk, useContracts, useCustomers, useMe, usePolicies } from "../../lib/queries";
import { normalizeDefinition } from "../contracts/policy-paths";
import { PolicySummary } from "./policy-summary";

const route = getRouteApi("/_app/policies");

const STATUS: Record<PolicyStatus, { label: string; tone: BadgeTone }> = {
  draft: { label: "Draft", tone: "warning" },
  active: { label: "Active", tone: "ok" },
  superseded: { label: "Superseded", tone: "neutral" },
  archived: { label: "Archived", tone: "outline" },
};

export function PoliciesPage() {
  const person = usePersonName();
  const { policyId } = route.useSearch();
  const navigate = useNavigate({ from: "/policies" });
  const policies = usePolicies();
  const contracts = useContracts();
  const customers = useCustomers();
  const items = policies.data?.items ?? [];
  const selected = items.find((p) => p.id === policyId) ?? null;
  const setSelected = (id: string | undefined) => navigate({ search: id ? { policyId: id } : {}, replace: true });

  const sorted = useMemo(() => {
    const order: Record<PolicyStatus, number> = { draft: 0, active: 1, superseded: 2, archived: 3 };
    return [...items].sort(
      (a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name) || b.version - a.version,
    );
  }, [items]);

  const usage = (id: string) => customers.data?.items.filter((c) => c.policyId === id).length ?? 0;

  return (
    <Page
      title="Policies"
      description="Machine-checkable SLA policies, versioned. Tickets are measured against the active version for their customer, or the default."
      actions={
        <Button asChild variant="primary">
          <Link to="/contracts">Extract from a contract</Link>
        </Button>
      }
    >
      <Card>
        {policies.isPending ? (
          <div className="p-5">
            <SkeletonRows rows={4} label="Loading policies" />
          </div>
        ) : policies.isError ? (
          <ErrorState error={policies.error} resource="policies" onRetry={() => policies.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState
            icon={<ScrollText />}
            title="No policies yet"
            description="Upload a contract and approve the extracted policy. It shows up here."
            action={
              <Button asChild variant="primary" size="sm">
                <Link to="/contracts">Upload a contract</Link>
              </Button>
            }
          />
        ) : (
          <Table aria-label="Policies">
            <THead>
              <TR>
                <TH>Policy</TH>
                <TH>Status</TH>
                <TH className="hidden md:table-cell">Source</TH>
                <TH className="hidden md:table-cell" align="right">
                  Targets
                </TH>
                <TH className="hidden lg:table-cell">Approved</TH>
                <TH align="right">
                  <span className="sr-only">Actions</span>
                </TH>
              </TR>
            </THead>
            <TBody>
              {sorted.map((p) => {
                const def = normalizeDefinition(p.definition, p.name);
                const contract = contracts.data?.items.find((c) => c.id === p.contractId);
                const n = usage(p.id);
                return (
                  <TR key={p.id} interactive onClick={() => setSelected(p.id)} selected={p.id === policyId}>
                    <TD>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          className="font-medium text-ink hover:underline"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelected(p.id);
                          }}
                        >
                          {p.name}
                        </button>
                        <span className="font-mono text-2xs text-ink-muted">v{p.version}</span>
                        {p.isDefault && (
                          <Badge tone="accent" size="sm" icon={<Star aria-hidden />}>
                            Default
                          </Badge>
                        )}
                      </div>
                      <span className="text-xs text-ink-muted">
                        {p.status === "active"
                          ? n
                            ? `${n} ${n === 1 ? "customer" : "customers"}`
                            : p.isDefault
                              ? "Customers without their own policy"
                              : "No customers assigned"
                          : `${def.calendar.timezone.replace(/_/g, " ")}`}
                      </span>
                    </TD>
                    <TD>
                      <Badge tone={STATUS[p.status].tone}>{STATUS[p.status].label}</Badge>
                    </TD>
                    <TD className="hidden max-w-64 md:table-cell">
                      {contract ? (
                        <Link
                          to="/contracts/$contractId"
                          params={{ contractId: contract.id }}
                          onClick={(e) => e.stopPropagation()}
                          className="block truncate text-xs text-accent-text hover:underline"
                        >
                          {contract.filename}
                        </Link>
                      ) : (
                        <span className="text-xs text-ink-muted">Written by hand</span>
                      )}
                    </TD>
                    <TD numeric className="hidden md:table-cell">
                      {def.targets.length}
                    </TD>
                    <TD className="hidden text-xs text-ink-muted lg:table-cell">
                      {p.approvedAt ? (
                        <>
                          <span className="text-ink">{person(p.approvedBy)}</span>
                          <span className="block">{formatDate(p.approvedAt)}</span>
                        </>
                      ) : (
                        "—"
                      )}
                    </TD>
                    <TD align="right" onClick={(e) => e.stopPropagation()}>
                      {p.status === "draft" && contract ? (
                        <Button asChild size="sm" variant="primary">
                          <Link to="/contracts/$contractId" params={{ contractId: contract.id }}>
                            Review <ArrowRight aria-hidden className="size-3.5" />
                          </Link>
                        </Button>
                      ) : (
                        <Button size="sm" variant="ghost" onClick={() => setSelected(p.id)}>
                          Details
                        </Button>
                      )}
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        )}
      </Card>

      <PolicySheet policy={selected} onClose={() => setSelected(undefined)} />
    </Page>
  );
}

function PolicySheet({ policy, onClose }: { policy: Policy | null; onClose: () => void }) {
  const person = usePersonName();
  const queryClient = useQueryClient();
  const me = useMe();
  const admin = me.data?.role === "owner" || me.data?.role === "admin";
  const [preview, setPreview] = useState<PolicyPreview | null>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const invalidate = () => queryClient.invalidateQueries({ queryKey: qk.policies });

  const makeDefault = useMutation({
    mutationFn: (id: string) => api.policies.update(id, { isDefault: true }),
    onSuccess: (p) => {
      toast({ tone: "success", title: `${p.name} is now the default policy` });
      void invalidate();
    },
    onError: (e) => toast({ tone: "error", title: "Couldn't change the default", description: errorMessage(e) }),
  });
  const archive = useMutation({
    mutationFn: (id: string) => api.policies.archive(id),
    onSuccess: (p) => {
      toast({ tone: "success", title: `${p.name} v${p.version} archived` });
      setConfirmArchive(false);
      void invalidate();
    },
    onError: (e) => toast({ tone: "error", title: "Couldn't archive", description: errorMessage(e) }),
  });
  const runPreview = useMutation({
    mutationFn: (id: string) => api.policies.preview(id, { days: 90 }),
    onSuccess: setPreview,
    onError: (e) => toast({ tone: "error", title: "Preview failed", description: errorMessage(e) }),
  });

  const def = policy ? normalizeDefinition(policy.definition, policy.name) : null;
  return (
    <Sheet
      open={policy !== null}
      onOpenChange={(o) => {
        if (!o) {
          setPreview(null);
          onClose();
        }
      }}
      width="lg"
      title={policy ? `${policy.name} · v${policy.version}` : "Policy"}
      description={
        policy
          ? policy.approvedAt
            ? `Approved by ${person(policy.approvedBy)} on ${formatDateTime(policy.approvedAt)}`
            : `Draft created ${formatDateTime(policy.createdAt)}`
          : undefined
      }
      footer={
        policy && (
          <>
            {policy.status !== "archived" && admin && (
              <Button
                variant="ghost"
                leadingIcon={<Archive />}
                onClick={() => setConfirmArchive(true)}
                className="mr-auto"
              >
                Archive
              </Button>
            )}
            <Button leadingIcon={<Gauge />} loading={runPreview.isPending} onClick={() => runPreview.mutate(policy.id)}>
              Preview 90 days
            </Button>
            {policy.status === "active" && !policy.isDefault && admin && (
              <Button
                variant="primary"
                leadingIcon={<Star />}
                loading={makeDefault.isPending}
                onClick={() => makeDefault.mutate(policy.id)}
              >
                Make default
              </Button>
            )}
          </>
        )
      }
    >
      {policy && def && (
        <div className="flex flex-col gap-5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={STATUS[policy.status].tone}>{STATUS[policy.status].label}</Badge>
            {policy.isDefault && (
              <Badge tone="accent" icon={<Star aria-hidden />}>
                Default for unmatched customers
              </Badge>
            )}
          </div>
          {preview && (
            <div className="rounded-lg border border-line bg-sunken/50 p-4">
              <p className="text-xs text-ink-muted">
                Last {preview.days} days · {formatNumber(preview.tickets)} tickets replayed against this version
              </p>
              <dl className="mt-2 grid grid-cols-3 gap-3">
                <div>
                  <dt className="text-2xs text-ink-muted">Breaches</dt>
                  <dd className="font-mono text-lg tnum">{formatNumber(preview.breaches)}</dd>
                </div>
                <div>
                  <dt className="text-2xs text-ink-muted">Attainment</dt>
                  <dd className="font-mono text-lg tnum">{formatPercent(preview.attainmentPercent)}</dd>
                </div>
                <div>
                  <dt className="text-2xs text-ink-muted">Exposure</dt>
                  <dd className="font-mono text-lg text-breached-text tnum">
                    {formatMoney(preview.exposureCents, "compact")}
                  </dd>
                </div>
              </dl>
            </div>
          )}
          {policy.status === "draft" && policy.contractId && (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-warning-border bg-warning-subtle/60 px-4 py-3 text-sm">
              <span>This draft isn't measuring tickets until it's approved.</span>
              <Button asChild size="sm" variant="primary">
                <Link to="/contracts/$contractId" params={{ contractId: policy.contractId }}>
                  Review
                </Link>
              </Button>
            </div>
          )}
          <PolicySummary def={def} />
        </div>
      )}
      <Dialog
        open={confirmArchive}
        onOpenChange={setConfirmArchive}
        size="sm"
        title="Archive this policy?"
        description="Customers assigned to it fall back to the default policy. Past evaluations keep this version for audit."
        footer={
          <>
            <Button onClick={() => setConfirmArchive(false)}>Cancel</Button>
            <Button variant="danger" loading={archive.isPending} onClick={() => policy && archive.mutate(policy.id)}>
              Archive
            </Button>
          </>
        }
      />
    </Sheet>
  );
}
