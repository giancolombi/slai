import type { CustomerAccount } from "@slai/shared";
import { upsertCustomerBody } from "@slai/shared";
import {
  Button,
  Card,
  Dialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  Field,
  formatMoney,
  IconButton,
  Input,
  RiskBadge,
  Select,
  SkeletonRows,
  Stat,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  toast,
} from "@slai/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Building2, MoreHorizontal, Pencil, Plus, Search, Ticket, Trash2 } from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";
import { ErrorState, Page } from "../../components/page";
import { GuideButton } from "../../help/guide-button";
import { api, errorMessage, isApiError } from "../../lib/api";
import { qk, useCustomers, useMe, usePolicies } from "../../lib/queries";

export function CustomersPage() {
  const customers = useCustomers();
  const policies = usePolicies();
  const me = useMe();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<CustomerAccount | "new" | null>(null);
  const [deleting, setDeleting] = useState<CustomerAccount | null>(null);
  const [q, setQ] = useState("");
  const canEdit = me.data?.role !== "viewer";

  const active = (policies.data?.items ?? []).filter((p) => p.status === "active");
  const defaultPolicy = active.find((p) => p.isDefault);
  const policyOptions = [
    { value: "default", label: defaultPolicy ? `Default (${defaultPolicy.name})` : "Default policy" },
    ...active.map((p) => ({ value: p.id, label: `${p.name} v${p.version}` })),
  ];

  const assign = useMutation({
    mutationFn: ({ id, policyId }: { id: string; policyId: string | null }) => api.customers.update(id, { policyId }),
    onSuccess: (c) => {
      toast({ tone: "success", title: `Policy updated for ${c.name}` });
      void queryClient.invalidateQueries({ queryKey: qk.customers });
    },
    onError: (e) => toast({ tone: "error", title: "Couldn't change the policy", description: errorMessage(e) }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.customers.remove(id),
    onSuccess: () => {
      toast({ tone: "success", title: `${deleting?.name ?? "Customer"} removed` });
      setDeleting(null);
      void queryClient.invalidateQueries({ queryKey: qk.customers });
    },
    onError: (e) => toast({ tone: "error", title: "Couldn't remove the customer", description: errorMessage(e) }),
  });

  const items = customers.data?.items ?? [];
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    const list = s
      ? items.filter((c) => c.name.toLowerCase().includes(s) || c.domains.some((d) => d.includes(s)))
      : items;
    return [...list].sort(
      (a, b) => b.atRiskTickets - a.atRiskTickets || (b.monthlyFeeCents ?? 0) - (a.monthlyFeeCents ?? 0),
    );
  }, [items, q]);

  const mrr = items.reduce((s, c) => s + (c.monthlyFeeCents ?? 0), 0);
  const atRisk = items.reduce((s, c) => s + c.atRiskTickets, 0);
  const noPolicy = items.filter((c) => !c.policyId).length;

  return (
    <Page
      title="Customers"
      description="Your customers, the fee each pays, and the SLA policy their tickets are measured against."
      actions={
        canEdit && (
          <Button variant="primary" leadingIcon={<Plus />} onClick={() => setEditing("new")}>
            Add customer
          </Button>
        )
      }
    >
      {customers.isSuccess && items.length > 0 && (
        <div className="mb-6 grid gap-3 sm:grid-cols-3">
          <Stat
            label="Monthly fees under SLA"
            value={formatMoney(mrr, "compact")}
            detail={`${items.length} customers`}
          />
          <Stat
            label="Tickets at risk or breached"
            value={atRisk}
            detailTone={atRisk ? "bad" : "good"}
            detail={atRisk ? "Across all customers, right now" : "Nothing at risk right now"}
          />
          <Stat
            label="On the default policy"
            value={noPolicy}
            detail={noPolicy ? "Without their own contract terms" : "Every customer has terms"}
          />
        </div>
      )}

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-4 pb-3">
          <h2 className="text-sm font-semibold text-ink">All customers</h2>
          <Input
            type="search"
            aria-label="Filter customers"
            placeholder="Filter by name or domain"
            leading={<Search />}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="w-full sm:w-64"
          />
        </div>
        {customers.isPending ? (
          <div className="px-5 pb-5">
            <SkeletonRows rows={6} label="Loading customers" />
          </div>
        ) : customers.isError ? (
          <ErrorState error={customers.error} resource="customers" onRetry={() => customers.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState
            icon={<Building2 />}
            title="No customers yet"
            description="Customers are matched from your help desk by organization ID, then email domain. Add one and assign it the policy from its contract; unmatched tickets use the default policy."
            action={
              <>
                {canEdit && (
                  <Button size="sm" variant="primary" leadingIcon={<Plus />} onClick={() => setEditing("new")}>
                    Add customer
                  </Button>
                )}
                <GuideButton guide="contract-review" anchor="assign" />
              </>
            }
          />
        ) : filtered.length === 0 ? (
          <EmptyState compact icon={<Search />} title={`No customers match “${q}”`} />
        ) : (
          <Table aria-label="Customers">
            <THead>
              <TR>
                <TH>Customer</TH>
                <TH align="right" className="hidden md:table-cell">
                  Monthly fee
                </TH>
                <TH>Policy</TH>
                <TH align="right">Open</TH>
                <TH>Risk now</TH>
                <TH align="right" className="hidden lg:table-cell">
                  Breaches (period)
                </TH>
                <TH align="right">
                  <span className="sr-only">Actions</span>
                </TH>
              </TR>
            </THead>
            <TBody>
              {filtered.map((c) => (
                <TR key={c.id}>
                  <TD>
                    <span className="block font-medium text-ink">{c.name}</span>
                    <span className="block text-xs text-ink-muted">{c.domains.join(", ") || "No domains"}</span>
                  </TD>
                  <TD numeric className="hidden md:table-cell">
                    {c.monthlyFeeCents === null ? (
                      <span className="text-ink-subtle">—</span>
                    ) : (
                      formatMoney(c.monthlyFeeCents)
                    )}
                  </TD>
                  <TD className="w-56">
                    <Select
                      size="sm"
                      aria-label={`Policy for ${c.name}`}
                      value={c.policyId ?? "default"}
                      disabled={!canEdit || policies.isPending}
                      onValueChange={(v) => assign.mutate({ id: c.id, policyId: v === "default" ? null : v })}
                      options={
                        c.policyId && !active.some((p) => p.id === c.policyId)
                          ? [...policyOptions, { value: c.policyId, label: "Archived policy" }]
                          : policyOptions
                      }
                      className="w-full"
                    />
                  </TD>
                  <TD numeric>
                    <Link
                      to="/tickets"
                      search={{ customerId: c.id }}
                      className="inline-flex items-center gap-1 hover:text-accent-text hover:underline"
                      aria-label={`${c.openTickets} open tickets for ${c.name}`}
                    >
                      <Ticket className="size-3 text-ink-subtle" aria-hidden />
                      {c.openTickets}
                    </Link>
                  </TD>
                  <TD>
                    {c.atRiskTickets > 0 ? (
                      <Link to="/tickets" search={{ customerId: c.id, risk: "at_risk" }}>
                        <RiskBadge risk="at_risk" size="sm" label={`${c.atRiskTickets} at risk`} />
                      </Link>
                    ) : (
                      <RiskBadge risk="ok" size="sm" />
                    )}
                  </TD>
                  <TD numeric className="hidden lg:table-cell">
                    <span className={c.breachesThisPeriod ? "text-breached-text" : "text-ink-muted"}>
                      {c.breachesThisPeriod}
                    </span>
                  </TD>
                  <TD align="right">
                    {canEdit && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <IconButton size="sm" label={`Actions for ${c.name}`} icon={<MoreHorizontal />} />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onSelect={() => setEditing(c)}>
                            <Pencil aria-hidden /> Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem asChild>
                            <Link to="/tickets" search={{ customerId: c.id }}>
                              <Ticket aria-hidden /> View tickets
                            </Link>
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem destructive onSelect={() => setDeleting(c)}>
                            <Trash2 aria-hidden /> Remove
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      {editing !== null && (
        <CustomerDialog
          customer={editing === "new" ? null : editing}
          policyOptions={policyOptions}
          onClose={() => setEditing(null)}
        />
      )}
      <Dialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        size="sm"
        title={`Remove ${deleting?.name ?? "customer"}?`}
        description="Their tickets stay in slai but fall back to the default policy. You can add the customer again later."
        footer={
          <>
            <Button onClick={() => setDeleting(null)}>Cancel</Button>
            <Button variant="danger" loading={remove.isPending} onClick={() => deleting && remove.mutate(deleting.id)}>
              Remove customer
            </Button>
          </>
        }
      />
    </Page>
  );
}

type Errors = Partial<Record<"name" | "domains" | "externalOrgIds" | "monthlyFeeCents" | "form", string>>;

const splitList = (s: string) =>
  s
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);

function CustomerDialog({
  customer,
  policyOptions,
  onClose,
}: {
  customer: CustomerAccount | null;
  policyOptions: { value: string; label: string }[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(customer?.name ?? "");
  const [domains, setDomains] = useState(customer?.domains.join(", ") ?? "");
  const [orgIds, setOrgIds] = useState(customer?.externalOrgIds.join(", ") ?? "");
  const [fee, setFee] = useState(customer?.monthlyFeeCents != null ? String(customer.monthlyFeeCents / 100) : "");
  const [policy, setPolicy] = useState(customer?.policyId ?? "default");
  const [errors, setErrors] = useState<Errors>({});

  const save = useMutation({
    mutationFn: (body: ReturnType<typeof upsertCustomerBody.parse>) =>
      customer ? api.customers.update(customer.id, body) : api.customers.create(body),
    onSuccess: (c) => {
      toast({ tone: "success", title: customer ? `${c.name} updated` : `${c.name} added` });
      void queryClient.invalidateQueries({ queryKey: qk.customers });
      onClose();
    },
    onError: (e) => {
      if (isApiError(e) && e.isValidation) setErrors({ form: e.message });
      else toast({ tone: "error", title: "Couldn't save the customer", description: errorMessage(e) });
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const feeNum = fee.trim() === "" ? null : Number(fee.replace(/[$,]/g, ""));
    if (feeNum !== null && (!Number.isFinite(feeNum) || feeNum < 0)) {
      setErrors({ monthlyFeeCents: "Enter a monthly fee in dollars, like 12500." });
      return;
    }
    const parsed = upsertCustomerBody.safeParse({
      name: name.trim(),
      domains: splitList(domains).map((d) => d.toLowerCase()),
      externalOrgIds: splitList(orgIds),
      monthlyFeeCents: feeNum === null ? null : Math.round(feeNum * 100),
      policyId: policy === "default" ? null : policy,
    });
    if (!parsed.success) {
      const next: Errors = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] as keyof Errors;
        next[key] ??= key === "name" ? "Enter the customer's name." : issue.message;
      }
      setErrors(next);
      return;
    }
    setErrors({});
    save.mutate(parsed.data);
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={customer ? `Edit ${customer.name}` : "Add customer"}
      description="Tickets are matched to a customer by requester email domain or help-desk organization ID."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="customer-form" loading={save.isPending}>
            {customer ? "Save changes" : "Add customer"}
          </Button>
        </>
      }
    >
      <form id="customer-form" onSubmit={submit} className="flex flex-col gap-4" noValidate>
        {errors.form && (
          <p role="alert" className="rounded-md bg-breached-subtle px-3 py-2 text-sm text-breached-text">
            {errors.form}
          </p>
        )}
        <Field label="Name" required error={errors.name}>
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="Northwind Health" />
        </Field>
        <Field label="Email domains" hint="Comma-separated, e.g. northwind.com, nw-health.com" error={errors.domains}>
          <Input value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="northwind.com" />
        </Field>
        <Field
          label="Help-desk organization IDs"
          hint="Optional. Matches tickets by organization when domains differ."
          error={errors.externalOrgIds}
        >
          <Input value={orgIds} onChange={(e) => setOrgIds(e.target.value)} placeholder="zd-4412" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Monthly fee" hint="Used to compute credits and exposure" error={errors.monthlyFeeCents}>
            <Input
              inputMode="decimal"
              value={fee}
              onChange={(e) => setFee(e.target.value)}
              leading={<span className="text-xs">$</span>}
              placeholder="12,500"
            />
          </Field>
          <Field label="SLA policy">
            <Select value={policy} onValueChange={setPolicy} options={policyOptions} className="w-full" />
          </Field>
        </div>
      </form>
    </Dialog>
  );
}
