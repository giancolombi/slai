import type { Contract, Replay } from "@slai/shared";
import { Button, Card, cn, EmptyState, Logo, Progress, Skeleton, ThemeToggle } from "@slai/ui";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeft,
  ArrowRight,
  Cable,
  Check,
  CircleAlert,
  FileSearch,
  FileSignature,
  History,
  ScrollText,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { ErrorState } from "../../components/page";
import { providerLabel } from "../../lib/labels";
import { useLiveUpdates } from "../../lib/live";
import { useConnections, useContract, useMe, useReplay } from "../../lib/queries";
import type { OnboardingStep } from "../../router";
import { ConnectHelpDesk } from "../connections/connector-form";
import { ProviderMark } from "../connections/provider-mark";
import { ContractReview } from "../contracts/contract-review";
import { ContractUpload } from "../contracts/upload-dropzone";
import { leadTime, ReplayHeadline, ReplayProgress, RunReplayForm } from "../replay/replay-parts";

const route = getRouteApi("/onboarding");

const STEPS: { id: OnboardingStep; title: string; blurb: string; icon: typeof Cable }[] = [
  { id: "connect", title: "Connect your help desk", blurb: "Read-only to start. Takes a minute.", icon: Cable },
  { id: "contract", title: "Upload a contract", blurb: "An MSA, SLA schedule or order form.", icon: FileSignature },
  { id: "review", title: "Review the policy", blurb: "Every number cited. You approve it.", icon: ScrollText },
  { id: "replay", title: "Run Breach Replay", blurb: "See the last 90 days, priced.", icon: History },
];

interface WizardState {
  connectionId?: string;
  contractId?: string;
  replayId?: string;
  approved?: boolean;
}

const STORAGE_KEY = "slai-onboarding";

function useWizardState() {
  const [state, setState] = useState<WizardState>(() => {
    try {
      return JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "{}") as WizardState;
    } catch {
      return {};
    }
  });
  useEffect(() => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* storage unavailable: state lasts for this page */
    }
  }, [state]);
  return [state, (patch: Partial<WizardState>) => setState((s) => ({ ...s, ...patch }))] as const;
}

function Stepper({ current, done }: { current: number; done: (id: OnboardingStep) => boolean }) {
  return (
    <ol className="flex flex-col gap-1" aria-label="Setup steps">
      {STEPS.map((s, i) => {
        const active = i === current;
        const complete = done(s.id) && !active;
        return (
          <li key={s.id}>
            <Link
              to="/onboarding"
              search={{ step: s.id }}
              aria-current={active ? "step" : undefined}
              className={cn(
                "flex items-start gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-hover",
                active && "bg-surface shadow-sm hover:bg-surface",
              )}
            >
              <span
                className={cn(
                  "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border font-mono text-2xs font-semibold tnum",
                  active && "border-accent bg-accent text-on-accent",
                  complete && "border-ok-border bg-ok-subtle text-ok-text",
                  !active && !complete && "border-line-strong text-ink-muted",
                )}
              >
                {complete ? <Check className="size-3.5" aria-label="Done" /> : i + 1}
              </span>
              <span className="min-w-0">
                <span className={cn("block text-sm font-medium", active ? "text-ink" : "text-ink-muted")}>
                  {s.title}
                </span>
                <span className="block text-xs text-ink-subtle">{s.blurb}</span>
              </span>
            </Link>
          </li>
        );
      })}
    </ol>
  );
}

function StepFrame({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <section aria-labelledby="step-title" className="flex flex-col gap-6">
      <div>
        <h1 id="step-title" className="text-2xl font-semibold tracking-tight text-ink">
          {title}
        </h1>
        <p className="mt-1.5 max-w-xl text-sm text-ink-muted">{description}</p>
      </div>
      {children}
      {footer && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5">{footer}</div>
      )}
    </section>
  );
}

function ConnectStep({ state, set, next }: StepProps) {
  const connections = useConnections();
  const existing = connections.data?.items ?? [];
  const connected = existing.find((c) => c.id === state.connectionId) ?? existing[0];
  const [adding, setAdding] = useState(false);
  return (
    <StepFrame
      title="Connect your help desk"
      description="slai reads tickets and their history to run every clock. It writes nothing until you turn on Assist or Autopilot."
      footer={
        <>
          <Button asChild variant="ghost">
            <Link to="/">Skip for now</Link>
          </Button>
          <Button variant="primary" disabled={!connected} onClick={next}>
            Continue <ArrowRight aria-hidden />
          </Button>
        </>
      }
    >
      {connections.isPending ? (
        <Skeleton className="h-60 rounded-lg" />
      ) : connections.isError ? (
        <ErrorState error={connections.error} resource="connections" onRetry={() => connections.refetch()} />
      ) : connected && !adding ? (
        <Card className="flex flex-wrap items-center gap-4 p-5">
          <ProviderMark provider={connected.provider} size="lg" />
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-1.5 text-sm font-semibold text-ink">
              <Check className="size-4 text-ok-text" aria-hidden /> {connected.name} is connected
            </p>
            <p className="text-xs text-ink-muted">
              {providerLabel(connected.provider)} · syncing 90 days of history in the background
            </p>
          </div>
          <Button size="sm" variant="ghost" onClick={() => setAdding(true)}>
            Connect another
          </Button>
        </Card>
      ) : (
        <Card className="p-5">
          <ConnectHelpDesk
            onConnected={(c) => {
              set({ connectionId: c.id });
              setAdding(false);
              next();
            }}
          />
        </Card>
      )}
    </StepFrame>
  );
}

function Extraction({
  contractId,
  onReady,
  onRetry,
}: {
  contractId: string;
  onReady: () => void;
  onRetry: () => void;
}) {
  const query = useContract(contractId);
  const c = query.data;
  if (query.isPending) return <Skeleton className="h-40 rounded-lg" />;
  if (query.isError) return <ErrorState error={query.error} resource="the contract" onRetry={() => query.refetch()} />;
  if (!c) return null;
  if (c.status === "failed") {
    return (
      <Card>
        <EmptyState
          tone="error"
          icon={<CircleAlert />}
          title="We couldn't read this contract"
          description={c.error ?? "Try a text PDF or DOCX."}
          action={<Button onClick={onRetry}>Upload another file</Button>}
        />
      </Card>
    );
  }
  if (c.status === "uploaded" || c.status === "extracting") {
    return (
      <Card className="p-6" aria-live="polite">
        <div className="flex items-start gap-3">
          <span className="flex size-9 items-center justify-center rounded-lg bg-accent-subtle text-accent-text">
            <FileSearch className="size-4.5" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-ink">Reading {c.filename}</p>
            <p className="text-xs text-ink-muted">
              Finding targets by priority, business hours, holidays, pause rules and credit clauses, with a citation for
              each.
            </p>
            <Progress label="Extracting the policy" className="mt-4" />
          </div>
        </div>
      </Card>
    );
  }
  const ex = c.extraction;
  return (
    <Card className="p-6">
      <div className="flex items-start gap-3">
        <span className="flex size-9 items-center justify-center rounded-lg bg-ok-subtle text-ok-text">
          <Check className="size-4.5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-ink">Policy extracted from {c.filename}</p>
          {ex && <p className="mt-1 text-sm text-ink-muted">{ex.summary}</p>}
          {ex && (
            <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-ink-muted tnum">
              <span>{ex.citations.length} citations</span>
              <span className={ex.ambiguities.length ? "text-warning-text" : undefined}>
                {ex.ambiguities.length} {ex.ambiguities.length === 1 ? "question" : "questions"} to resolve
              </span>
            </p>
          )}
        </div>
        <Button variant="primary" onClick={onReady}>
          Review policy <ArrowRight aria-hidden />
        </Button>
      </div>
    </Card>
  );
}

function ContractStep({ state, set, next, go }: StepProps) {
  return (
    <StepFrame
      title="Upload an SLA contract"
      description="PDF, DOCX, TXT or Markdown up to 20 MB. slai extracts the policy and cites the clause behind every number. Nothing goes live until you approve it."
      footer={
        <>
          <Button variant="ghost" onClick={() => go("connect")}>
            <ArrowLeft aria-hidden /> Back
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => go("replay")}>
              Skip for now
            </Button>
            <Button variant="primary" disabled={!state.contractId} onClick={next}>
              Continue <ArrowRight aria-hidden />
            </Button>
          </div>
        </>
      }
    >
      {state.contractId ? (
        <Extraction contractId={state.contractId} onReady={next} onRetry={() => set({ contractId: undefined })} />
      ) : (
        <ContractUpload onUploaded={(c: Contract) => set({ contractId: c.id, approved: false })} />
      )}
    </StepFrame>
  );
}

function ReviewStep({ state, set, next, go }: StepProps) {
  if (!state.contractId) {
    return (
      <StepFrame title="Review the policy" description="Upload a contract first; its extracted policy appears here.">
        <Card>
          <EmptyState
            icon={<FileSignature />}
            title="No contract yet"
            action={
              <Button variant="primary" onClick={() => go("contract")}>
                Upload a contract
              </Button>
            }
          />
        </Card>
      </StepFrame>
    );
  }
  return (
    <StepFrame
      title="Review the extracted policy"
      description="Check each number against its citation, resolve the open questions, then approve. The policy starts measuring tickets immediately."
      footer={
        <>
          <Button variant="ghost" onClick={() => go("contract")}>
            <ArrowLeft aria-hidden /> Back
          </Button>
          <Button variant={state.approved ? "primary" : "ghost"} onClick={next}>
            {state.approved ? "Continue" : "Skip for now"} <ArrowRight aria-hidden />
          </Button>
        </>
      }
    >
      <ContractReview
        contractId={state.contractId}
        embedded
        onApproved={() => {
          set({ approved: true });
          next();
        }}
      />
    </StepFrame>
  );
}

function ReplayResult({ replayId }: { replayId: string }) {
  const query = useReplay(replayId);
  if (query.isPending) return <Skeleton className="h-40 rounded-lg" />;
  if (query.isError) return <ErrorState error={query.error} resource="the replay" onRetry={() => query.refetch()} />;
  const r: Replay = query.data;
  if (r.status === "failed") {
    return (
      <Card>
        <EmptyState
          tone="error"
          icon={<CircleAlert />}
          title="The replay failed"
          description="Check the connection and try again."
        />
      </Card>
    );
  }
  if (!r.result) {
    return (
      <Card className="p-6">
        <p className="text-sm font-semibold text-ink">Replaying the last {r.days} days</p>
        <p className="mt-1 text-xs text-ink-muted">Every ticket is timed exactly the way slai times live tickets.</p>
        <ReplayProgress replay={r} className="mt-5" />
      </Card>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <ReplayHeadline result={r.result} />
      <p className="text-sm text-ink-muted">
        {r.result.breaches} breaches you didn't see coming. With slai on, each would have raised an alert a median{" "}
        <strong className="text-ink">{leadTime(r.result.medianLeadMinutes)}</strong> before the breach.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button asChild variant="primary">
          <Link to="/replay/$replayId" params={{ replayId: r.id }}>
            Open full report <ArrowRight aria-hidden />
          </Link>
        </Button>
        <Button asChild>
          <Link to="/">Go to dashboard</Link>
        </Button>
      </div>
    </div>
  );
}

function ReplayStep({ state, set, go }: StepProps) {
  const connections = useConnections();
  return (
    <StepFrame
      title="Run Breach Replay"
      description="Replay your recent tickets against your contracts: breaches you missed, the credits they put at risk, and how much warning slai would have given."
      footer={
        <>
          <Button variant="ghost" onClick={() => go("review")}>
            <ArrowLeft aria-hidden /> Back
          </Button>
          <Button asChild variant={state.replayId ? "primary" : "ghost"}>
            <Link to="/">{state.replayId ? "Finish" : "Skip to dashboard"}</Link>
          </Button>
        </>
      }
    >
      {state.replayId ? (
        <ReplayResult replayId={state.replayId} />
      ) : connections.isPending ? (
        <Skeleton className="h-48 rounded-lg" />
      ) : connections.isError ? (
        <ErrorState error={connections.error} resource="connections" onRetry={() => connections.refetch()} />
      ) : connections.data.items.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Cable />}
            title="Connect a help desk first"
            description="Replay reads your ticket history from your help desk."
            action={
              <Button variant="primary" onClick={() => go("connect")}>
                Connect a help desk
              </Button>
            }
          />
        </Card>
      ) : (
        <Card className="max-w-md p-5">
          <RunReplayForm connections={connections.data.items} onStarted={(r) => set({ replayId: r.id })} />
        </Card>
      )}
    </StepFrame>
  );
}

interface StepProps {
  state: WizardState;
  set: (patch: Partial<WizardState>) => void;
  next: () => void;
  go: (step: OnboardingStep) => void;
}

export function OnboardingPage() {
  const { step = "connect" } = route.useSearch();
  const navigate = useNavigate();
  const me = useMe();
  // Extraction and replay progress arrive as live events here too (the wizard has no app shell).
  useLiveUpdates(me.data?.organization.id, import.meta.env.VITE_MOCK_API !== "1");
  const [state, set] = useWizardState();
  const index = STEPS.findIndex((s) => s.id === step);
  const go = (s: OnboardingStep) => navigate({ to: "/onboarding", search: { step: s } });
  const next = () => {
    const n = STEPS[index + 1];
    if (n) go(n.id);
  };
  useEffect(() => {
    document.title = `${STEPS[index]?.title ?? "Get started"} · slai`;
  }, [index]);

  const done = (id: OnboardingStep) =>
    id === "connect"
      ? Boolean(state.connectionId)
      : id === "contract"
        ? Boolean(state.contractId)
        : id === "review"
          ? Boolean(state.approved)
          : Boolean(state.replayId);

  const props: StepProps = { state, set, next, go };
  return (
    <div className="min-h-dvh bg-canvas">
      <div className="flex h-14 items-center gap-3 border-b border-line px-4 md:px-8">
        <Logo />
        <span className="hidden text-sm text-ink-muted sm:inline">
          Setting up <span className="font-medium text-ink">{me.data?.organization.name ?? "your organization"}</span>
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <ThemeToggle />
          <Button asChild variant="ghost" size="sm">
            <Link to="/">Exit setup</Link>
          </Button>
        </div>
      </div>
      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-8 md:px-8 lg:grid-cols-[260px_1fr] lg:py-12">
        <aside className="flex flex-col gap-4">
          <div>
            <p className="text-xs font-medium text-ink-muted">
              Step {index + 1} of {STEPS.length}
            </p>
            <Progress value={((index + 1) / STEPS.length) * 100} label="Setup progress" className="mt-2" />
          </div>
          <div className="hidden lg:block">
            <Stepper current={index} done={done} />
          </div>
        </aside>
        <main id="main" className="min-w-0">
          {step === "connect" && <ConnectStep {...props} />}
          {step === "contract" && <ContractStep {...props} />}
          {step === "review" && <ReviewStep {...props} />}
          {step === "replay" && <ReplayStep {...props} />}
        </main>
      </div>
    </div>
  );
}
