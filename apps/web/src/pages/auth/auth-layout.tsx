import { Logo, type Risk, RiskBadge, riskForFraction, SlaBar, SlaClock, ThemeToggle, useNow } from "@slai/ui";
import { Link, Outlet } from "@tanstack/react-router";
import { useState } from "react";

const MIN = 60_000;

interface DemoClock {
  key: string;
  subject: string;
  customer: string;
  metric: string;
  targetMs: number;
  dueAt: number;
}

function useDemoClocks(): DemoClock[] {
  const [start] = useState(() => Date.now());
  return [
    {
      key: "#48227",
      subject: "SSO login loop after certificate rotation",
      customer: "Northwind Health",
      metric: "First response",
      targetMs: 60 * MIN,
      dueAt: start + 9 * MIN + 41_000,
    },
    {
      key: "OPS-1192",
      subject: "Webhook deliveries delayed by 30+ minutes",
      customer: "Kestrel Bank",
      metric: "Resolution",
      targetMs: 240 * MIN,
      dueAt: start + 83 * MIN + 12_000,
    },
    {
      key: "#48262",
      subject: "Billing export missing March invoices",
      customer: "Halcyon Retail",
      metric: "Next response",
      targetMs: 720 * MIN,
      dueAt: start + 541 * MIN,
    },
  ];
}

/** A small live board: the product's core material (time) on the sign-in screen. */
function LiveBoard() {
  const now = useNow();
  const clocks = useDemoClocks();
  return (
    <div className="flex flex-col gap-2.5" aria-hidden>
      {clocks.map((c) => {
        const elapsed = c.targetMs - (c.dueAt - now);
        const risk: Risk = riskForFraction(elapsed / c.targetMs);
        return (
          <div
            key={c.key}
            className="rounded-lg border border-white/10 bg-white/[0.04] p-3.5 backdrop-blur-sm"
            style={{ boxShadow: "0 1px 0 rgb(255 255 255 / 0.04) inset" }}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-white">{c.subject}</p>
                <p className="mt-0.5 font-mono text-2xs text-white/55">
                  {c.key} · {c.customer} · {c.metric}
                </p>
              </div>
              <RiskBadge risk={risk} size="sm" />
            </div>
            <div className="mt-3 flex items-center gap-3">
              <SlaBar label={c.metric} elapsedMs={elapsed} targetMs={c.targetMs} size="sm" className="flex-1" />
              <SlaClock dueAt={new Date(c.dueAt).toISOString()} size="sm" className="w-24 justify-end" />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function AuthLayout() {
  return (
    <div className="grid min-h-dvh bg-canvas lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <aside
        data-theme="dark"
        className="relative hidden overflow-hidden lg:flex lg:flex-col lg:justify-between lg:p-10 xl:p-14"
        style={{
          background:
            "radial-gradient(120% 80% at 0% 0%, color-mix(in oklab, var(--dial-500) 38%, transparent) 0%, transparent 60%), radial-gradient(90% 70% at 100% 100%, color-mix(in oklab, var(--dial-700) 30%, transparent) 0%, transparent 55%), var(--ink-950)",
        }}
      >
        <svg
          aria-hidden
          viewBox="0 0 600 600"
          className="pointer-events-none absolute -right-40 -bottom-40 size-[560px] opacity-[0.07]"
        >
          {Array.from({ length: 60 }, (_, i) => (
            <line
              // biome-ignore lint/suspicious/noArrayIndexKey: static dial ticks
              key={i}
              x1="300"
              y1={i % 5 === 0 ? 30 : 44}
              x2="300"
              y2="64"
              stroke="white"
              strokeWidth={i % 5 === 0 ? 4 : 2}
              transform={`rotate(${i * 6} 300 300)`}
            />
          ))}
          <circle cx="300" cy="300" r="268" fill="none" stroke="white" strokeWidth="2" />
        </svg>
        <Link to="/login" className="relative w-fit rounded-sm">
          <Logo />
        </Link>
        <div className="relative flex max-w-md flex-col gap-8">
          <div>
            <h2 className="text-3xl font-semibold tracking-tight text-white">Never miss the SLA you signed.</h2>
            <p className="mt-3 text-md leading-relaxed text-white/65">
              slai reads your support contracts, runs every ticket on an exact clock, and warns you before a breach, not
              after the credit is owed.
            </p>
          </div>
          <LiveBoard />
        </div>
        <p className="relative text-xs text-white/45">
          Clocks are computed by a deterministic engine. Models never decide whether you breached.
        </p>
      </aside>
      <main className="relative flex flex-col items-center justify-center px-4 py-12 sm:px-8">
        <div className="absolute top-4 right-4">
          <ThemeToggle />
        </div>
        <div className="mb-8 lg:hidden">
          <Logo />
        </div>
        <div className="w-full max-w-sm">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

/** Shared heading for auth forms. */
export function AuthHeading({ title, description }: { title: string; description?: React.ReactNode }) {
  return (
    <div className="mb-7">
      <h1 className="text-2xl font-semibold tracking-tight text-ink">{title}</h1>
      {description && <p className="mt-1.5 text-sm text-ink-muted">{description}</p>}
    </div>
  );
}

export function FormAlert({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="alert"
      className="rounded-md border border-breached-border bg-breached-subtle px-3 py-2.5 text-sm text-breached-text"
    >
      {children}
    </div>
  );
}
