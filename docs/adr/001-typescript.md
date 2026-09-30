# ADR-001: TypeScript full stack

**Status:** accepted · 2026-09-29

## Context

The founder was open to Go, Rust, or TypeScript. The question was whether
Go or Rust would buy a real performance benefit.

## Decision

TypeScript on Node 24 for every component (web, API, worker, engine, agents).

## Why

- **The workload is I/O-bound.** Nearly all wall time is spent waiting on
  help-desk APIs (rate-limited at 100–700 req/min), model APIs (seconds per
  call), and E2B sandbox boot and execution. A faster language speeds up none
  of these. Node's event loop handles thousands of concurrent in-flight
  requests per process.
- **The CPU-bound part is small and bounded.** SLA evaluation is O(events +
  calendar days) per ticket. For scale, 100k open tickets re-evaluated every
  minute is roughly 1.6k evaluations per second. That is a few cores' worth of
  JavaScript and scales horizontally, because the engine is pure.
- **Ecosystem.** E2B's SDK, the Anthropic SDK and Claude Agent SDK, and the
  OpenAI SDK are first-class in TypeScript. Most help-desk vendors publish JS
  SDKs and examples.
- **One type system.** The UI renders the engine's own `MetricResult` and
  `TicketEvaluation` types, and the API validates with the same zod schemas.

## Honest answer to "is there a performance benefit?"

TypeScript is not faster than Go or Rust. It has **no meaningful performance
cost for this workload** and a large velocity benefit. If profiling ever shows
the evaluator is the bottleneck, it is a pure function with a narrow interface
that can be ported to Rust and called through napi-rs without touching anything else.
