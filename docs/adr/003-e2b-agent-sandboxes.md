# ADR-003: Every agent run happens in a disposable E2B sandbox

**Status:** accepted · 2026-09-29

## Context

Agents read untrusted content: ticket bodies written by our customers'
customers, and uploaded contracts. Anything they read can try to instruct
them. We also want many agents running concurrently without sharing state.

## Decision

- One E2B sandbox per agent run, created from a pinned template build
  (`sandbox/`), destroyed at the end of the run or at its time limit.
- The sandbox receives an **immutable input manifest** (ticket thread, policy
  summary, evaluation, knowledge snippets). It returns a **proposal** as
  structured JSON validated with zod by the worker.
- The sandbox has **no database access, no connector credentials, and no
  write path to the help desk.** Only the worker writes, and only after
  validation and the autonomy/guardrail decision.
- Network egress is allowlisted to the model provider endpoints.
- Hard bounds on every run: wall time, tokens, and tool calls. Exceeding a
  bound is a failed run, never a partial success.
- For local development `AGENT_RUNTIME=local` runs the same agent code
  in-process, and `MODEL_PROVIDER=mock` returns deterministic fixtures. The
  product runs end to end without any keys.
