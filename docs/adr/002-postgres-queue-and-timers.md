# ADR-002: Postgres (pg-boss) for jobs and SLA timers, not Temporal

**Status:** accepted · 2026-09-29

## Context

Every open ticket needs to be re-evaluated at precise future instants (the
next warn threshold, the due time), whether or not the help desk sends us an
event. Agent runs, syncs, and write-backs need retries and concurrency limits.

## Decision

- Each ticket row stores `next_check_at`, recomputed on every evaluation. A
  sweep job (every 15s) claims due tickets with `FOR UPDATE SKIP LOCKED` and
  enqueues `evaluate-ticket` jobs.
- pg-boss provides the job queue (retries, backoff, singleton keys per ticket,
  concurrency per queue). It runs in the same Postgres.

## Why not Temporal (yet)

Temporal fits long-running, multi-step workflows. Ours are short: evaluate,
decide, run one agent, and write back. The state that outlives a job (a draft
awaiting approval) is a row, not a workflow. Postgres keeps timers
transactional with the data they describe. It is also one less critical system
to secure, monitor, and put in SOC 2 scope.

**Revisit when** agent work becomes multi-hour, multi-step, and
human-in-the-loop, for example autonomous resolution that reproduces bugs and
waits on engineering.
