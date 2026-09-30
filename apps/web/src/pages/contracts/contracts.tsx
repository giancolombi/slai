import type { Contract, ContractStatus } from "@slai/shared";
import {
  Badge,
  type BadgeTone,
  Button,
  Card,
  CardHeader,
  EmptyState,
  formatDateTime,
  formatRelative,
  SkeletonRows,
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
import { Link, useNavigate } from "@tanstack/react-router";
import {
  Archive,
  ArrowRight,
  CircleCheck,
  CircleHelp,
  FileSignature,
  FileText,
  LoaderCircle,
  OctagonX,
  RotateCcw,
  Upload,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { ErrorState, Page } from "../../components/page";
import { api, errorMessage } from "../../lib/api";
import { personLabel } from "../../lib/people";
import { qk, useContracts, useCustomers } from "../../lib/queries";
import { ContractUpload } from "./upload-dropzone";

const STATUS: Record<ContractStatus, { label: string; tone: BadgeTone; icon: ReactNode }> = {
  uploaded: { label: "Queued", tone: "accent", icon: <LoaderCircle className="animate-spin" aria-hidden /> },
  extracting: { label: "Extracting", tone: "accent", icon: <LoaderCircle className="animate-spin" aria-hidden /> },
  needs_review: { label: "Needs review", tone: "warning", icon: <CircleHelp aria-hidden /> },
  approved: { label: "Approved", tone: "ok", icon: <CircleCheck aria-hidden /> },
  failed: { label: "Failed", tone: "breached", icon: <OctagonX aria-hidden /> },
  archived: { label: "Archived", tone: "neutral", icon: <Archive aria-hidden /> },
};

export function ContractStatusBadge({ status }: { status: ContractStatus }) {
  const s = STATUS[status];
  return (
    <Badge tone={s.tone} icon={s.icon}>
      {s.label}
    </Badge>
  );
}

export function ContractsPage() {
  const contracts = useContracts();
  const customers = useCustomers();
  const [showUpload, setShowUpload] = useState(false);
  const items = contracts.data?.items ?? [];
  const review = items.filter((c) => c.status === "needs_review").length;
  const empty = contracts.isSuccess && items.length === 0;

  return (
    <Page
      title="Contracts"
      description="Upload the SLAs you've signed. slai extracts a policy with a citation for every number, and nothing goes live until you approve it."
      actions={
        !empty && (
          <Button
            variant="primary"
            leadingIcon={<Upload />}
            onClick={() => setShowUpload((s) => !s)}
            aria-expanded={showUpload}
          >
            Upload contract
          </Button>
        )
      }
    >
      {(showUpload || empty) && (
        <Card className="mb-6 p-4">
          <ContractUpload />
        </Card>
      )}

      {review > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-warning-border bg-warning-subtle/60 px-4 py-3 text-sm">
          <CircleHelp className="size-4 text-warning-text" aria-hidden />
          <span className="font-medium text-ink">
            {review} {review === 1 ? "contract is" : "contracts are"} waiting for review.
          </span>
          <span className="text-ink-muted">Their policies aren't measuring tickets yet.</span>
        </div>
      )}

      <Card>
        <CardHeader
          title="All contracts"
          description={
            contracts.isSuccess ? `${items.length} ${items.length === 1 ? "document" : "documents"}` : undefined
          }
        />
        {contracts.isPending ? (
          <div className="px-5 pb-5">
            <SkeletonRows rows={5} label="Loading contracts" />
          </div>
        ) : contracts.isError ? (
          <ErrorState error={contracts.error} resource="contracts" onRetry={() => contracts.refetch()} />
        ) : empty ? (
          <EmptyState
            icon={<FileSignature />}
            title="No contracts yet"
            description="Drop your first SLA contract above. Breach Replay and live clocks start from an approved policy."
          />
        ) : (
          <ContractsTable
            items={items}
            customerName={(id) => customers.data?.items.find((c) => c.id === id)?.name ?? null}
          />
        )}
      </Card>
    </Page>
  );
}

function ContractsTable({
  items,
  customerName,
}: {
  items: Contract[];
  customerName: (id: string | null) => string | null;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const retry = useMutation({
    mutationFn: (id: string) => api.contracts.extract(id),
    onSuccess: () => {
      toast({ tone: "success", title: "Extraction restarted" });
      void queryClient.invalidateQueries({ queryKey: qk.contracts });
    },
    onError: (e) => toast({ tone: "error", title: "Couldn't restart extraction", description: errorMessage(e) }),
  });
  const order: Record<ContractStatus, number> = {
    needs_review: 0,
    extracting: 1,
    uploaded: 1,
    failed: 2,
    approved: 3,
    archived: 4,
  };
  const sorted = [...items].sort(
    (a, b) => order[a.status] - order[b.status] || b.uploadedAt.localeCompare(a.uploadedAt),
  );
  return (
    <Table aria-label="Contracts">
      <THead>
        <TR>
          <TH>Document</TH>
          <TH>Status</TH>
          <TH className="hidden md:table-cell">Findings</TH>
          <TH className="hidden lg:table-cell">Uploaded</TH>
          <TH align="right">
            <span className="sr-only">Actions</span>
          </TH>
        </TR>
      </THead>
      <TBody>
        {sorted.map((c) => {
          const openable = c.status !== "extracting" && c.status !== "uploaded";
          const customer = customerName(c.customerAccountId);
          const ex = c.extraction;
          return (
            <TR
              key={c.id}
              interactive={openable}
              onClick={
                openable ? () => navigate({ to: "/contracts/$contractId", params: { contractId: c.id } }) : undefined
              }
            >
              <TD className="max-w-0 w-[45%]">
                <div className="flex items-center gap-3">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-line bg-sunken text-ink-muted">
                    <FileText className="size-4" aria-hidden />
                  </span>
                  <div className="min-w-0">
                    <Link
                      to="/contracts/$contractId"
                      params={{ contractId: c.id }}
                      onClick={(e) => e.stopPropagation()}
                      className="block truncate font-medium text-ink hover:underline"
                    >
                      {c.filename}
                    </Link>
                    <span className="block truncate text-xs text-ink-muted">
                      {customer ?? "Default terms · no customer"}
                    </span>
                  </div>
                </div>
              </TD>
              <TD>
                <ContractStatusBadge status={c.status} />
              </TD>
              <TD className="hidden text-xs text-ink-muted md:table-cell">
                {ex ? (
                  <span className="inline-flex flex-wrap gap-x-3 gap-y-0.5">
                    <span>
                      <span className="font-mono text-ink tnum">{ex.citations.length}</span> citations
                    </span>
                    <span
                      className={ex.ambiguities.length && c.status === "needs_review" ? "text-warning-text" : undefined}
                    >
                      <span className="font-mono tnum">{ex.ambiguities.length}</span>{" "}
                      {ex.ambiguities.length === 1 ? "ambiguity" : "ambiguities"}
                    </span>
                  </span>
                ) : c.status === "failed" ? (
                  <Tooltip content={c.error ?? "Extraction failed"}>
                    <button type="button" className="line-clamp-1 max-w-64 cursor-help text-left text-breached-text">
                      {c.error}
                    </button>
                  </Tooltip>
                ) : (
                  "—"
                )}
              </TD>
              <TD className="hidden text-xs text-ink-muted lg:table-cell">
                <span title={formatDateTime(c.uploadedAt)}>{formatRelative(c.uploadedAt)}</span>
                <span className="block">{personLabel(c.uploadedBy, c.uploadedByName)}</span>
              </TD>
              <TD align="right" onClick={(e) => e.stopPropagation()}>
                {c.status === "needs_review" && (
                  <Button asChild size="sm" variant="primary">
                    <Link to="/contracts/$contractId" params={{ contractId: c.id }}>
                      Review <ArrowRight aria-hidden className="size-3.5" />
                    </Link>
                  </Button>
                )}
                {c.status === "approved" && (
                  <Button asChild size="sm" variant="ghost">
                    <Link to="/contracts/$contractId" params={{ contractId: c.id }}>
                      View
                    </Link>
                  </Button>
                )}
                {c.status === "failed" && (
                  <Button
                    size="sm"
                    leadingIcon={<RotateCcw />}
                    loading={retry.isPending && retry.variables === c.id}
                    onClick={() => retry.mutate(c.id)}
                  >
                    Retry
                  </Button>
                )}
                {(c.status === "extracting" || c.status === "uploaded") && (
                  <span className="text-xs text-ink-muted">Usually under a minute</span>
                )}
              </TD>
            </TR>
          );
        })}
      </TBody>
    </Table>
  );
}
