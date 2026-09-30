import type { Contract, Policy, PolicyPreview } from "@slai/shared";
import type { SlaPolicy } from "@slai/sla-engine";
import {
  Badge,
  Button,
  Card,
  CitationQuote,
  cn,
  EmptyState,
  formatDateTime,
  formatMoney,
  formatNumber,
  formatPercent,
  formatRelative,
  Progress,
  SegmentedControl,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tooltip,
  toast,
} from "@slai/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeft,
  Check,
  CircleCheck,
  CircleHelp,
  Download,
  FileSearch,
  FileText,
  FileWarning,
  Gauge,
  Lock,
  PencilLine,
  Quote,
  RotateCcw,
  Save,
  ShieldCheck,
  Undo2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ErrorState, Page } from "../../components/page";
import { WhatsThis } from "../../help/whats-this";
import { api, errorMessage, isApiError } from "../../lib/api";
import { personLabel } from "../../lib/people";
import { qk, useContract, useCustomers, useMe, usePolicy } from "../../lib/queries";
import { type DocumentFocus, DocumentPane } from "./document-pane";
import { PolicyForm } from "./policy-form";
import {
  citationDomId,
  definedPaths,
  extractionPath,
  fieldDomId,
  normalizeDefinition,
  pathLabel,
} from "./policy-paths";
import { type Citation, ReviewContext, type ReviewContextValue } from "./review-context";
import { isResolved, type Resolution, reviewGate } from "./review-gate";

const route = getRouteApi("/_app/contracts/$contractId");

export function ContractReviewPage() {
  const { contractId } = route.useParams();
  const navigate = useNavigate();
  return (
    <ContractReview
      contractId={contractId}
      onApproved={(p) => navigate({ to: "/policies", search: { policyId: p.id } })}
    />
  );
}

export interface ContractReviewProps {
  contractId: string;
  onApproved?: (policy: Policy) => void;
  /** Inside another flow (onboarding): no page chrome. */
  embedded?: boolean;
}

/** Review an extracted policy against its contract, resolve ambiguities, and approve it. */
export function ContractReview({ contractId, onApproved, embedded = false }: ContractReviewProps) {
  const contract = useContract(contractId);
  const customers = useCustomers();
  const customerName = customers.data?.items.find((c) => c.id === contract.data?.customerAccountId)?.name ?? null;

  const frame = (children: React.ReactNode, title?: string) =>
    embedded ? (
      <div>{children}</div>
    ) : (
      <Page
        width="wide"
        docTitle={title ?? "Review contract"}
        eyebrow={
          <Link to="/contracts" className="inline-flex items-center gap-1 hover:text-ink">
            <ArrowLeft className="size-3.5" aria-hidden /> Contracts
          </Link>
        }
        title={title ?? "Review contract"}
        description={
          contract.data ? (
            <span className="inline-flex flex-wrap items-center gap-x-2">
              {customerName && <span className="font-medium text-ink">{customerName}</span>}
              <span>
                Uploaded by {personLabel(contract.data.uploadedBy, contract.data.uploadedByName) ?? "someone"}{" "}
                {formatRelative(contract.data.uploadedAt)}
              </span>
            </span>
          ) : undefined
        }
        actions={
          contract.data && (
            <Button asChild size="sm" variant="ghost" leadingIcon={<Download />}>
              <a href={api.contracts.fileUrl(contractId)} target="_blank" rel="noreferrer">
                <Download aria-hidden className="size-3.5" /> Original
              </a>
            </Button>
          )
        }
      >
        {children}
      </Page>
    );

  if (contract.isPending) return frame(<ReviewSkeleton />);
  if (contract.isError) {
    if (isApiError(contract.error) && contract.error.isNotFound) {
      return frame(
        <EmptyState
          icon={<FileSearch />}
          title="Contract not found"
          description="It may have been archived or belong to another organization."
          action={
            <Button asChild size="sm">
              <Link to="/contracts">Back to contracts</Link>
            </Button>
          }
        />,
      );
    }
    return frame(<ErrorState error={contract.error} resource="the contract" onRetry={() => contract.refetch()} />);
  }
  const c = contract.data;
  const title = c.filename.replace(/\.(pdf|docx|txt|md)$/i, "");
  if (c.status === "uploaded" || c.status === "extracting") return frame(<Extracting contract={c} />, title);
  if (c.status === "failed") return frame(<ExtractionFailed contract={c} />, title);
  if (!c.extraction || c.extraction.policyIds.length === 0)
    return frame(
      <EmptyState
        icon={<FileSearch />}
        title="No SLA schedule found"
        description="slai couldn't find any SLA terms in this document."
      />,
      title,
    );
  return frame(<Reviewer contract={c} onApproved={onApproved} embedded={embedded} />, title);
}

// ---------------------------------------------------------------- states

function ReviewSkeleton() {
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_400px]" role="status" aria-live="polite">
      <span className="sr-only">Loading contract…</span>
      <div className="flex flex-col gap-4">
        <Skeleton className="h-28 w-full rounded-lg" />
        <Skeleton className="h-64 w-full rounded-lg" />
        <Skeleton className="h-80 w-full rounded-lg" />
      </div>
      <div className="flex flex-col gap-3">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-24 w-full rounded-md" />
        ))}
      </div>
    </div>
  );
}

const STEPS = [
  "Reading the document",
  "Finding SLA schedules",
  "Extracting targets, hours and credits",
  "Verifying every citation",
];

function Extracting({ contract }: { contract: Contract }) {
  const started = new Date(contract.uploadedAt).getTime();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  const elapsed = Math.max(0, now - started);
  const step = Math.min(STEPS.length - 1, Math.floor(elapsed / 1800));
  return (
    <Card className="mx-auto max-w-xl p-8">
      <div className="flex items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-xl bg-accent-subtle text-accent-text">
          <FileText className="size-5" aria-hidden />
        </span>
        <div>
          <h2 className="text-md font-semibold text-ink">Extracting the SLA policy</h2>
          <p className="text-sm text-ink-muted">{contract.filename}</p>
        </div>
      </div>
      <Progress className="mt-6" label="Extraction progress" value={Math.min(92, 8 + (elapsed / 8000) * 84)} />
      <ol className="mt-5 flex flex-col gap-2.5" aria-live="polite">
        {STEPS.map((s, i) => (
          <li
            key={s}
            className={cn(
              "flex items-center gap-2.5 text-sm",
              i < step ? "text-ink-muted" : i === step ? "text-ink font-medium" : "text-ink-subtle",
            )}
          >
            <span
              aria-hidden
              className={cn(
                "flex size-5 items-center justify-center rounded-full border",
                i < step && "border-ok-border bg-ok-subtle text-ok-text",
                i === step && "border-accent animate-pulse-ring text-accent-text",
                i > step && "border-line",
              )}
            >
              {i < step && <Check className="size-3" strokeWidth={3} />}
            </span>
            {s}
            {i === step && <span className="sr-only">(in progress)</span>}
          </li>
        ))}
      </ol>
      <p className="mt-6 text-xs text-ink-muted">
        An AI agent reads the contract. Every number it proposes must quote the clause it came from, and nothing goes
        live until a person approves it.
      </p>
    </Card>
  );
}

function ExtractionFailed({ contract }: { contract: Contract }) {
  const queryClient = useQueryClient();
  const retry = useMutation({
    mutationFn: () => api.contracts.extract(contract.id),
    onSuccess: () => {
      toast({ tone: "success", title: "Reading the contract again" });
      void queryClient.invalidateQueries({ queryKey: qk.contracts });
    },
    onError: (e) =>
      toast({ tone: "error", title: "Couldn't start reading the contract again", description: errorMessage(e) }),
  });
  return (
    <Card className="mx-auto max-w-xl">
      <EmptyState
        tone="error"
        icon={<FileWarning />}
        title="We couldn't read this contract"
        description={contract.error ?? "Try again, or upload a clearer copy (PDF, DOCX or text)."}
        action={
          <>
            <Button
              variant="primary"
              size="sm"
              loading={retry.isPending}
              leadingIcon={<RotateCcw />}
              onClick={() => retry.mutate()}
            >
              Retry extraction
            </Button>
            <Button asChild size="sm">
              <Link to="/contracts">Upload a different file</Link>
            </Button>
          </>
        }
      />
    </Card>
  );
}

// ---------------------------------------------------------------- reviewer

function Reviewer({
  contract,
  onApproved,
  embedded,
}: {
  contract: Contract;
  onApproved?: (p: Policy) => void;
  embedded: boolean;
}) {
  const ids = contract.extraction!.policyIds;
  const [policyId, setPolicyId] = useState(ids[0]!);
  const policy = usePolicy(policyId);
  return (
    <div className="flex flex-col gap-4">
      {ids.length > 1 && (
        <SegmentedControl
          aria-label="Extracted policies"
          value={policyId}
          onValueChange={setPolicyId}
          options={ids.map((id, i) => ({ value: id, label: `Schedule ${i + 1}` }))}
        />
      )}
      {policy.isPending ? (
        <ReviewSkeleton />
      ) : policy.isError ? (
        <ErrorState error={policy.error} resource="the extracted policy" onRetry={() => policy.refetch()} />
      ) : (
        <PolicyReview
          key={policy.data.id}
          contract={contract}
          policy={policy.data}
          onApproved={onApproved}
          embedded={embedded}
        />
      )}
    </div>
  );
}

function useResolutions(policyId: string) {
  const key = `slai-review-${policyId}`;
  const [resolutions, setResolutions] = useState<Record<string, Resolution | undefined>>(() => {
    try {
      return JSON.parse(sessionStorage.getItem(key) ?? "{}");
    } catch {
      return {};
    }
  });
  useEffect(() => {
    try {
      sessionStorage.setItem(key, JSON.stringify(resolutions));
    } catch {
      /* per-tab convenience only */
    }
  }, [key, resolutions]);
  return [resolutions, setResolutions] as const;
}

function PolicyReview({
  contract,
  policy,
  onApproved,
  embedded,
}: {
  contract: Contract;
  policy: Policy;
  onApproved?: (p: Policy) => void;
  embedded: boolean;
}) {
  const queryClient = useQueryClient();
  const me = useMe();
  const extraction = contract.extraction!;
  const [original, setOriginal] = useState<SlaPolicy>(() => normalizeDefinition(policy.definition, policy.name));
  const [draft, setDraft] = useState<SlaPolicy>(original);
  const [resolutions, setResolutions] = useResolutions(policy.id);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [preview, setPreview] = useState<PolicyPreview | null>(null);
  const [paneTab, setPaneTab] = useState<"document" | "citations">("document");
  const [docFocus, setDocFocus] = useState<DocumentFocus | null>(null);
  const citationsRef = useRef<HTMLDivElement>(null);

  const readOnly = policy.status !== "draft";
  const dirty = JSON.stringify(draft) !== JSON.stringify(original);
  // "Changed" is judged against the extraction, not the last save.
  const extracted = useMemo(
    () => normalizeDefinition(policy.definition, policy.name),
    [policy.definition, policy.name],
  );
  // One contract can yield several policies; keep only this policy's evidence, keyed by semantic path.
  const policyIndex = Math.max(0, extraction.policyIds.indexOf(policy.id));
  const scopedCitations = useMemo(
    () =>
      extraction.citations.flatMap((c) => {
        const path = extractionPath(c.path, policyIndex, extracted);
        return path ? [{ ...c, path }] : [];
      }),
    [extraction.citations, policyIndex, extracted],
  );
  const citations = useMemo(
    () => new Map<string, Citation>(scopedCitations.map((c) => [c.path, c])),
    [scopedCitations],
  );
  const ambiguities = useMemo(
    () =>
      extraction.ambiguities.flatMap((a) => {
        const path = extractionPath(a.path, policyIndex, extracted);
        return path ? [{ ...a, path }] : [];
      }),
    [extraction.ambiguities, policyIndex, extracted],
  );

  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: qk.contracts }),
      queryClient.invalidateQueries({ queryKey: qk.policies }),
      queryClient.invalidateQueries({ queryKey: qk.customers }),
    ]);

  const save = useMutation({
    mutationFn: () => api.policies.update(policy.id, { name: draft.name, definition: draft }),
    onSuccess: (p) => {
      setOriginal(draft);
      queryClient.setQueryData(qk.policy(p.id), p);
      toast({ tone: "success", title: "Draft saved" });
    },
    onError: (e) => toast({ tone: "error", title: "Couldn't save the draft", description: errorMessage(e) }),
  });

  const approve = useMutation({
    mutationFn: async () => {
      if (dirty) await api.policies.update(policy.id, { name: draft.name, definition: draft });
      return api.policies.approve(policy.id);
    },
    onSuccess: async (p) => {
      queryClient.setQueryData(qk.policy(p.id), p);
      await invalidate();
      try {
        sessionStorage.removeItem(`slai-review-${policy.id}`);
      } catch {
        /* ignore */
      }
      toast({
        tone: "success",
        title: `${p.name} v${p.version} is live`,
        description: "Tickets for this customer are now measured against the approved policy.",
      });
      onApproved?.(p);
    },
    onError: (e) => toast({ tone: "error", title: "Couldn't approve the policy", description: errorMessage(e) }),
  });

  const runPreview = useMutation({
    mutationFn: async () => {
      if (dirty) {
        await api.policies.update(policy.id, { name: draft.name, definition: draft });
        setOriginal(draft);
      }
      return api.policies.preview(policy.id, { days: 90 });
    },
    onSuccess: setPreview,
    onError: (e) => toast({ tone: "error", title: "Preview failed", description: errorMessage(e) }),
  });

  const saving = save.isPending || approve.isPending;
  const gate = reviewGate({
    ambiguities,
    resolutions,
    original: extracted,
    definition: draft,
    role: me.data?.role ?? "viewer",
    policyStatus: policy.status,
    saving,
  });
  const unresolved = new Set(gate.unresolved);
  const issues = new Map(gate.issues.map((i) => [i.path, i.message]));

  // A citation marker (or "Show in contract") opens the document at the quoted passage.
  const showCitation = useCallback((path: string) => {
    setActivePath(path);
    setPaneTab("document");
    setDocFocus({ path, nonce: Date.now() });
  }, []);

  const jumpToField = useCallback((path: string) => {
    setActivePath(path);
    const el = document.getElementById(fieldDomId(path));
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    const focusable = el.querySelector<HTMLElement>("input:not([disabled]), button:not([disabled]), [tabindex='0']");
    setTimeout(() => focusable?.focus({ preventScroll: true }), 250);
  }, []);

  const activate = useCallback((path: string | null, via: "focus" | "hover") => {
    if (via === "hover") {
      setActivePath((cur) => (path === null ? cur : path));
      return;
    }
    setActivePath(path);
    if (path) {
      const el = document.getElementById(citationDomId(path));
      const box = citationsRef.current;
      if (el && box && box.scrollHeight > box.clientHeight) el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, []);

  const ctx: ReviewContextValue = {
    citations,
    ambiguous: new Set(ambiguities.map((a) => a.path)),
    unresolved,
    issues,
    activePath,
    readOnly,
    activate,
    showCitation,
  };

  const fields = definedPaths(draft);
  const cited = fields.filter((p) => citations.has(p)).length;
  const resolvedCount = ambiguities.length - gate.unresolved.length;

  return (
    <ReviewContext.Provider value={ctx}>
      <div className="flex flex-col gap-5 pb-24">
        <Summary
          contract={contract}
          policy={policy}
          cited={cited}
          fields={fields.length}
          resolved={resolvedCount}
          total={ambiguities.length}
        />

        {!readOnly && ambiguities.length > 0 && (
          <AmbiguityPanel
            ambiguities={ambiguities}
            resolutions={resolutions}
            isResolved={(p) => isResolved({ resolutions, original: extracted, definition: draft }, p)}
            onConfirm={(p) => setResolutions((r) => ({ ...r, [p]: { kind: "confirmed" } }))}
            onChanged={(p) => setResolutions((r) => ({ ...r, [p]: { kind: "changed" } }))}
            onUndo={(p) => setResolutions((r) => ({ ...r, [p]: undefined }))}
            onJump={jumpToField}
            valueDiffers={(p) =>
              isResolved({ resolutions: { [p]: { kind: "changed" } }, original: extracted, definition: draft }, p)
            }
            label={(p) => pathLabel(p, draft)}
          />
        )}

        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(360px,480px)]">
          <PolicyForm value={draft} onChange={setDraft} />
          <aside
            aria-label="The contract and its citations"
            className={cn("flex flex-col gap-3", !embedded && "lg:sticky lg:top-20")}
          >
            {preview && <PreviewCard preview={preview} onClose={() => setPreview(null)} />}
            <Tabs value={paneTab} onValueChange={(v) => setPaneTab(v as "document" | "citations")}>
              <TabsList aria-label="Contract views">
                <TabsTrigger value="document">
                  <FileText aria-hidden /> Contract
                </TabsTrigger>
                <TabsTrigger value="citations">
                  <Quote aria-hidden /> Citations
                  <span className="font-mono text-2xs text-ink-muted tnum">{scopedCitations.length}</span>
                </TabsTrigger>
              </TabsList>
              {/* Kept mounted so the reader's place in the document survives a look at the list. */}
              <TabsContent value="document" forceMount className="pt-3 data-[state=inactive]:hidden">
                <DocumentPane
                  contractId={contract.id}
                  citations={scopedCitations}
                  activePath={activePath}
                  focus={docFocus}
                  unresolved={unresolved}
                  label={(p) => pathLabel(p, draft)}
                  onSelectPath={jumpToField}
                />
              </TabsContent>
              <TabsContent value="citations" className="pt-3">
                <p className="mb-2 flex items-center gap-1 text-xs text-ink-muted">
                  Each value's source text in the contract <WhatsThis concept="citations" />
                </p>
                <div
                  ref={citationsRef}
                  className="flex max-h-none flex-col gap-2.5 overflow-y-auto pr-1 scrollbar-thin lg:max-h-[calc(100dvh-15rem)]"
                >
                  {scopedCitations.length === 0 && (
                    <p className="rounded-md border border-dashed border-line-strong p-4 text-sm text-ink-muted">
                      The extraction returned no citations. Check every value against the original document.
                    </p>
                  )}
                  {scopedCitations.map((c) => (
                    // biome-ignore lint/a11y/noStaticElementInteractions: hover preview; the quote's field button is the keyboard path
                    <div
                      key={c.path}
                      id={citationDomId(c.path)}
                      className="flex scroll-mt-4 flex-col items-start gap-1"
                      onMouseEnter={() => setActivePath(c.path)}
                    >
                      <CitationQuote
                        className="w-full"
                        quote={c.quote}
                        document={c.document}
                        page={c.page}
                        fieldLabel={pathLabel(c.path, draft)}
                        active={activePath === c.path}
                        ambiguous={unresolved.has(c.path)}
                        onSelect={() => jumpToField(c.path)}
                      />
                      <Button
                        size="sm"
                        variant="ghost"
                        leadingIcon={<FileSearch />}
                        onClick={() => showCitation(c.path)}
                        aria-label={`Show the quote for ${pathLabel(c.path, draft)} in the contract`}
                      >
                        Show in contract
                      </Button>
                    </div>
                  ))}
                </div>
              </TabsContent>
            </Tabs>
          </aside>
        </div>
      </div>

      <ActionBar
        readOnly={readOnly}
        policy={policy}
        dirty={dirty}
        gate={gate}
        saving={save.isPending}
        approving={approve.isPending}
        previewing={runPreview.isPending}
        onSave={() => save.mutate()}
        onApprove={() => approve.mutate()}
        onPreview={() => runPreview.mutate()}
        onReset={() => setDraft(original)}
        embedded={embedded}
      />
    </ReviewContext.Provider>
  );
}

function Summary({
  contract,
  policy,
  cited,
  fields,
  resolved,
  total,
}: {
  contract: Contract;
  policy: Policy;
  cited: number;
  fields: number;
  resolved: number;
  total: number;
}) {
  const approved = policy.status !== "draft";
  return (
    <Card className="overflow-hidden">
      <div className="grid gap-5 p-5 md:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-md font-semibold text-ink">{policy.name}</h2>
            <Badge tone="outline" size="sm">
              v{policy.version}
            </Badge>
            {approved ? (
              <Badge tone="ok" size="sm" icon={<CircleCheck aria-hidden />}>
                {policy.status === "active"
                  ? "Active"
                  : policy.status === "superseded"
                    ? "Replaced by a newer version"
                    : "Archived"}
              </Badge>
            ) : (
              <Badge tone="warning" size="sm" icon={<PencilLine aria-hidden />}>
                Draft · needs approval
              </Badge>
            )}
          </div>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-ink-muted">{contract.extraction?.summary}</p>
          {approved && policy.approvedBy && (
            <p className="mt-3 inline-flex items-center gap-1.5 text-xs text-ink-muted">
              <Lock className="size-3.5" aria-hidden />
              Approved by{" "}
              <span className="font-medium text-ink">{personLabel(policy.approvedBy, policy.approvedByName)}</span>
              {policy.approvedAt && <> on {formatDateTime(policy.approvedAt)}</>}. Approved versions are read-only.
            </p>
          )}
        </div>
        <dl className="flex gap-6 md:border-l md:border-line md:pl-6">
          <div>
            <dt className="text-2xs font-semibold tracking-wide text-ink-muted uppercase">Evidence</dt>
            <dd className="mt-1 font-mono text-xl text-ink tnum">
              {cited}
              <span className="text-ink-subtle">/{fields}</span>
            </dd>
            <dd className="text-xs text-ink-muted">values cited</dd>
          </div>
          <div>
            <dt className="text-2xs font-semibold tracking-wide text-ink-muted uppercase">Ambiguities</dt>
            <dd
              className={cn(
                "mt-1 font-mono text-xl tnum",
                total > resolved && !approved ? "text-warning-text" : "text-ink",
              )}
            >
              {approved ? total : resolved}
              <span className="text-ink-subtle">/{total}</span>
            </dd>
            <dd className="text-xs text-ink-muted">{approved ? "resolved" : "resolved"}</dd>
          </div>
        </dl>
      </div>
    </Card>
  );
}

function AmbiguityPanel({
  ambiguities,
  resolutions,
  isResolved: resolvedFn,
  onConfirm,
  onChanged,
  onUndo,
  onJump,
  valueDiffers,
  label,
}: {
  ambiguities: NonNullable<Contract["extraction"]>["ambiguities"];
  resolutions: Record<string, Resolution | undefined>;
  isResolved: (path: string) => boolean;
  onConfirm: (path: string) => void;
  onChanged: (path: string) => void;
  onUndo: (path: string) => void;
  onJump: (path: string) => void;
  valueDiffers: (path: string) => boolean;
  label: (path: string) => string;
}) {
  const open = ambiguities.filter((a) => !resolvedFn(a.path)).length;
  return (
    <section
      aria-labelledby="ambiguities-title"
      className={cn(
        "rounded-lg border p-4 md:p-5",
        open ? "border-warning-border bg-warning-subtle/60" : "border-ok-border bg-ok-subtle/60",
      )}
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 id="ambiguities-title" className="flex items-center gap-2 text-sm font-semibold text-ink">
          {open ? (
            <CircleHelp className="size-4 text-warning-text" aria-hidden />
          ) : (
            <CircleCheck className="size-4 text-ok-text" aria-hidden />
          )}
          {open
            ? `${open} ${open === 1 ? "question needs" : "questions need"} a decision before approval`
            : "Every ambiguity is resolved"}
          <WhatsThis concept="ambiguity" />
        </h2>
        <span className="text-xs text-ink-muted">
          The contract doesn't settle these. slai made an assumption; confirm it or change the value.
        </span>
      </div>
      <ol className="flex flex-col gap-2.5">
        {ambiguities.map((a, i) => {
          const done = resolvedFn(a.path);
          const r = resolutions[a.path];
          const pendingChange = r?.kind === "changed" && !done;
          return (
            <li
              key={a.path}
              className={cn(
                "rounded-md border bg-surface p-3.5 transition-colors",
                done ? "border-line" : "border-warning-border shadow-xs",
              )}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-2xs text-ink-subtle tnum">Q{i + 1}</span>
                    <button
                      type="button"
                      onClick={() => onJump(a.path)}
                      className="text-xs font-medium text-accent-text hover:underline"
                    >
                      {label(a.path)}
                    </button>
                    {done && (
                      <Badge tone="ok" size="sm" icon={<Check aria-hidden />}>
                        {r?.kind === "changed" ? "Resolved: changed" : "Resolved: assumption confirmed"}
                      </Badge>
                    )}
                  </div>
                  <p className="mt-1 text-sm font-medium text-ink">{a.question}</p>
                  {!done && (
                    <>
                      {a.quote && (
                        <p className="mt-2 border-l-2 border-warning pl-3 font-serif text-[13.5px] leading-relaxed text-ink-muted">
                          “{a.quote}”
                        </p>
                      )}
                      <p className="mt-2 text-sm text-ink-muted">
                        <span className="font-medium text-ink">Assumed: </span>
                        {a.assumption}
                      </p>
                    </>
                  )}
                  {pendingChange && (
                    <p className="mt-2 text-xs font-medium text-warning-text">
                      Edit the highlighted value, then mark it as changed.
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  {done ? (
                    <Button size="sm" variant="ghost" leadingIcon={<Undo2 />} onClick={() => onUndo(a.path)}>
                      Undo
                    </Button>
                  ) : (
                    <>
                      {valueDiffers(a.path) ? (
                        <Button size="sm" leadingIcon={<PencilLine />} onClick={() => onChanged(a.path)}>
                          Mark as changed
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          leadingIcon={<PencilLine />}
                          onClick={() => {
                            onChanged(a.path);
                            onJump(a.path);
                          }}
                        >
                          Change value
                        </Button>
                      )}
                      <Button size="sm" variant="primary" leadingIcon={<Check />} onClick={() => onConfirm(a.path)}>
                        Confirm assumption
                      </Button>
                    </>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function PreviewCard({ preview, onClose }: { preview: PolicyPreview; onClose: () => void }) {
  return (
    <Card className="animate-pop-in p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-ink">
            <Gauge className="size-4 text-accent-text" aria-hidden />
            Impact over the last {preview.days} days
          </h3>
          <p className="text-xs text-ink-muted">Replayed {formatNumber(preview.tickets)} tickets against this draft.</p>
        </div>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Hide
        </Button>
      </div>
      <dl className="mt-3 grid grid-cols-3 gap-3">
        <div>
          <dt className="text-2xs text-ink-muted">Breaches</dt>
          <dd className="font-mono text-lg text-ink tnum">{formatNumber(preview.breaches)}</dd>
        </div>
        <div>
          <dt className="text-2xs text-ink-muted">Attainment</dt>
          <dd className="font-mono text-lg text-ink tnum">{formatPercent(preview.attainmentPercent)}</dd>
        </div>
        <div>
          <dt className="text-2xs text-ink-muted">Exposure</dt>
          <dd className="font-mono text-lg text-breached-text tnum">{formatMoney(preview.exposureCents, "compact")}</dd>
        </div>
      </dl>
    </Card>
  );
}

function ActionBar({
  readOnly,
  policy,
  dirty,
  gate,
  saving,
  approving,
  previewing,
  onSave,
  onApprove,
  onPreview,
  onReset,
  embedded,
}: {
  readOnly: boolean;
  policy: Policy;
  dirty: boolean;
  gate: ReturnType<typeof reviewGate>;
  saving: boolean;
  approving: boolean;
  previewing: boolean;
  onSave: () => void;
  onApprove: () => void;
  onPreview: () => void;
  onReset: () => void;
  embedded: boolean;
}) {
  const blockers = gate.blockers.filter((b) => b !== "Saving…");
  const approveButton = (
    <Button
      variant="primary"
      leadingIcon={<ShieldCheck />}
      loading={approving}
      disabled={!gate.canApprove}
      aria-describedby={!gate.canApprove ? "approve-blockers" : undefined}
      onClick={onApprove}
    >
      Approve policy
    </Button>
  );
  return (
    <div
      className={cn(
        "z-[var(--z-sticky)] border-t border-line bg-surface/92 backdrop-blur-md",
        embedded
          ? "sticky bottom-0 -mx-1 mt-4 rounded-b-lg px-4 py-3"
          : "sticky bottom-0 -mx-4 px-4 py-3 md:-mx-8 md:px-8",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div id="approve-blockers" className="min-w-0 text-sm" aria-live="polite">
          {readOnly ? (
            <span className="inline-flex items-center gap-1.5 text-ink-muted">
              <Lock className="size-4" aria-hidden />
              {policy.status === "active"
                ? "This version is live."
                : policy.status === "superseded"
                  ? "A newer version has replaced this one."
                  : "This version is archived."}
            </span>
          ) : gate.canApprove ? (
            <span className="inline-flex items-center gap-1.5 font-medium text-ok-text">
              <CircleCheck className="size-4" aria-hidden /> Ready to approve.
              {dirty && <span className="font-normal text-ink-muted"> Your edits are saved on approval.</span>}
            </span>
          ) : (
            <span className="inline-flex flex-wrap items-center gap-x-1.5 text-ink-muted">
              <CircleHelp className="size-4 shrink-0 text-warning-text" aria-hidden />
              <span className="sr-only">Approval blocked:</span>
              <span className="font-medium text-ink">{blockers[0]}</span>
              {blockers.length > 1 && (
                <Tooltip
                  content={
                    <ul className="list-disc pl-4">
                      {blockers.map((b) => (
                        <li key={b}>{b}</li>
                      ))}
                    </ul>
                  }
                >
                  <button type="button" className="text-xs text-accent-text underline-offset-2 hover:underline">
                    +{blockers.length - 1} more
                  </button>
                </Tooltip>
              )}
            </span>
          )}
        </div>
        {!readOnly && (
          <div className="flex flex-wrap items-center gap-2">
            {dirty && (
              <Button variant="ghost" size="md" leadingIcon={<Undo2 />} onClick={onReset}>
                Discard edits
              </Button>
            )}
            <Button leadingIcon={<Gauge />} loading={previewing} onClick={onPreview}>
              Preview impact
            </Button>
            <Button leadingIcon={<Save />} loading={saving} disabled={!dirty} onClick={onSave}>
              Save draft
            </Button>
            {gate.canApprove ? (
              approveButton
            ) : (
              <Tooltip content={blockers.join(" ") || "Not ready"}>
                {/* biome-ignore lint/a11y/noNoninteractiveTabindex: disabled buttons can't take focus, so the wrapper carries the reason */}
                <span tabIndex={0} className="rounded-md">
                  {approveButton}
                </span>
              </Tooltip>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
