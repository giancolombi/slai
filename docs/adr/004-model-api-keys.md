# ADR-004: Model access through commercial API keys only

**Status:** accepted · 2026-09-29

## Context

The initial plan was to power agent features with the team's Claude Max
(and ChatGPT/Codex) subscriptions and bill customers for their spend.

## Decision

slai calls models only through **commercial API keys**:
- Anthropic Console / Claude API, with `ANTHROPIC_API_KEY`
- OpenAI API, with `OPENAI_API_KEY`

Consumer subscriptions are never used by the product.

## Why

- **Terms.** Claude Max and ChatGPT Plus/Pro are individual consumer
  subscriptions. Using them to run a multi-tenant product that processes
  third parties' data is outside their terms. API keys are the product path.
- **SOC 2 and customer contracts.** Customer ticket data must flow under
  commercial data terms: no training on inputs, a DPA, and zero data retention
  where available. We will make those commitments to our customers, and the
  consumer terms do not support them.
- **Metering.** API responses report exact token usage per call, which is
  what we bill customers from (`usage_ledger`).

## Consequences

- Agent SDKs (Claude Agent SDK, Codex) run with API-key authentication.
- The provider layer records `{provider, model, input, output, cache tokens,
  cost}` for every call and attributes it to an org and a ticket.
