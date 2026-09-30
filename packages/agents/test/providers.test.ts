import Anthropic from "@anthropic-ai/sdk";
import type { Response } from "openai/resources/responses/responses";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { costMicros, PRICES } from "../src/pricing.js";
import { type AnthropicLike, AnthropicProvider } from "../src/providers/anthropic.js";
import { createProvider } from "../src/providers/index.js";
import { toStrictJsonSchema } from "../src/providers/json-schema.js";
import { type OpenAILike, OpenAIProvider } from "../src/providers/openai.js";
import { FallbackProvider, RetryingProvider, type RetryOptions } from "../src/providers/resilient.js";
import { type GenerateRequest, ProviderError } from "../src/providers/types.js";
import type { AgentKind } from "../src/types.js";

const schema = z.object({ label: z.string().min(1), score: z.number().min(0).max(1), note: z.string().nullable() });
const req = (task: AgentKind = "triage", extra: Partial<GenerateRequest<z.infer<typeof schema>>> = {}) => ({
  task,
  system: "SYSTEM PROMPT",
  schemaName: "thing",
  schema,
  maxOutputTokens: 1234,
  messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "DATA" }] }],
  ...extra,
});

type Body = Anthropic.Beta.Messages.MessageCreateParamsStreaming;

function anthropicMessage(text: string, over: Record<string, unknown> = {}): Anthropic.Beta.Messages.BetaMessage {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5",
    content: [{ type: "text", text, citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_input_tokens: 5000,
      cache_creation_input_tokens: 400,
      iterations: null,
    },
    ...over,
  } as unknown as Anthropic.Beta.Messages.BetaMessage;
}

function fakeAnthropic(results: (Anthropic.Beta.Messages.BetaMessage | Error)[]) {
  const bodies: Body[] = [];
  const client: AnthropicLike = {
    beta: {
      messages: {
        stream(body) {
          bodies.push(body);
          const r = results[Math.min(bodies.length - 1, results.length - 1)]!;
          return { finalMessage: async () => (r instanceof Error ? Promise.reject(r) : r) };
        },
      },
    },
  };
  return { client, bodies };
}

const apiError = (status: number) =>
  Anthropic.APIError.generate(status, { error: { type: "x", message: `status ${status}` } }, undefined, new Headers());

const noSleep: RetryOptions = { retries: 2, baseDelayMs: 1, maxDelayMs: 1, sleep: async () => {}, random: () => 0 };

describe("AnthropicProvider", () => {
  it("routes triage to Haiku without effort or server fallback, with a cached system prompt and strict schema", async () => {
    const { client, bodies } = fakeAnthropic([anthropicMessage('{"label":"bug","score":0.5,"note":null}')]);
    const r = await new AnthropicProvider(client).generate(req("triage"));
    expect(r).toMatchObject({ ok: true, value: { label: "bug", score: 0.5, note: null } });
    const b = bodies[0]!;
    expect(b.model).toBe("claude-haiku-4-5");
    expect(b.max_tokens).toBe(1234);
    expect(b.stream).toBe(true);
    expect(b.system).toEqual([{ type: "text", text: "SYSTEM PROMPT", cache_control: { type: "ephemeral" } }]);
    expect(b.output_config).toEqual({ format: { type: "json_schema", schema: toStrictJsonSchema(schema) } });
    expect(b).not.toHaveProperty("fallbacks");
    expect(b).not.toHaveProperty("thinking");
  });

  it("routes drafts to Sonnet 5.5 and extraction to Opus 5.5 with effort and server-side refusal fallback", async () => {
    const { client, bodies } = fakeAnthropic([anthropicMessage('{"label":"x","score":1,"note":"n"}')]);
    const p = new AnthropicProvider(client);
    await p.generate(req("draft_reply"));
    await p.generate(
      req("contract_extraction", {
        messages: [
          {
            role: "user",
            content: [
              { type: "pdf", filename: "c.pdf", base64: "JVBERi0=" },
              { type: "text", text: "DATA" },
            ],
          },
        ],
      }),
    );
    expect(bodies[0]).toMatchObject({
      model: "claude-sonnet-5-5",
      output_config: { effort: "medium" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    expect(bodies[1]).toMatchObject({ model: "claude-opus-5-5", output_config: { effort: "high" } });
    expect(bodies[1]!.messages[0]!.content).toEqual([
      { type: "document", title: "c.pdf", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" } },
      { type: "text", text: "DATA" },
    ]);
  });

  it("meters exact usage including cache tokens, priced per model", async () => {
    const { client } = fakeAnthropic([anthropicMessage('{"label":"x","score":1,"note":null}')]);
    const r = await new AnthropicProvider(client).generate(req("triage"));
    // Haiku 4.5: $1 in, $5 out, $0.10 cache read, $1.25 cache write per MTok.
    // 1000*1 + 200*5 + 5000*0.1 + 400*1.25 = 1000 + 1000 + 500 + 500 = 3000 micro-dollars.
    expect(r.usage).toEqual([
      {
        provider: "anthropic",
        model: "claude-haiku-4-5",
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 5000,
        cacheWriteTokens: 400,
        costMicros: 3000,
      },
    ]);
  });

  it("meters each attempt from usage.iterations when a server-side fallback served the response", async () => {
    const msg = anthropicMessage('{"label":"x","score":1,"note":null}', {
      model: "claude-opus-5",
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        iterations: [
          {
            type: "message",
            model: "claude-opus-5-5",
            input_tokens: 1000,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_creation: null,
          },
          {
            type: "fallback_message",
            model: "claude-opus-5",
            input_tokens: 1000,
            output_tokens: 100,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_creation: null,
          },
        ],
      },
    });
    const { client } = fakeAnthropic([msg]);
    const r = await new AnthropicProvider(client).generate(req("contract_extraction"));
    expect(r.usage.map((u) => [u.model, u.costMicros])).toEqual([
      ["claude-opus-5-5", 4000],
      ["claude-opus-5", 5000 + 2500],
    ]);
  });

  it("reports refusal, truncation and invalid JSON without throwing", async () => {
    const { client } = fakeAnthropic([
      anthropicMessage("", { stop_reason: "refusal" }),
      anthropicMessage('{"label":', { stop_reason: "max_tokens" }),
      anthropicMessage("not json"),
      anthropicMessage('{"label":"","score":3,"note":null}'),
    ]);
    const p = new AnthropicProvider(client);
    expect(await p.generate(req())).toMatchObject({ ok: false, reason: "refused" });
    expect(await p.generate(req())).toMatchObject({ ok: false, reason: "truncated" });
    expect(await p.generate(req())).toMatchObject({
      ok: false,
      reason: "invalid",
      issues: ["output is not valid JSON"],
    });
    const bad = await p.generate(req());
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues.join()).toMatch(/label.*score/);
  });

  it("maps SDK errors to ProviderError with retryability", async () => {
    for (const [status, retryable] of [
      [429, true],
      [500, true],
      [529, true],
      [400, false],
      [401, false],
    ] as const) {
      const { client } = fakeAnthropic([apiError(status)]);
      const e = await new AnthropicProvider(client).generate(req()).catch((x) => x);
      expect(e).toBeInstanceOf(ProviderError);
      expect(e).toMatchObject({ provider: "anthropic", status, retryable });
    }
  });
});

function openaiResponse(text: string, over: Partial<Response> = {}): Response {
  return {
    id: "resp_1",
    model: "gpt-6-luna",
    status: "completed",
    output_text: text,
    output: [
      {
        type: "message",
        id: "m",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
    usage: {
      input_tokens: 3000,
      input_tokens_details: { cached_tokens: 1000 },
      output_tokens: 500,
      output_tokens_details: { reasoning_tokens: 100 },
      total_tokens: 3500,
    },
    ...over,
  } as unknown as Response;
}

function fakeOpenAI(results: (Response | Error)[]) {
  const bodies: Parameters<OpenAILike["responses"]["create"]>[0][] = [];
  const client: OpenAILike = {
    responses: {
      create: async (body) => {
        bodies.push(body);
        const r = results[Math.min(bodies.length - 1, results.length - 1)]!;
        if (r instanceof Error) throw r;
        return r;
      },
    },
  };
  return { client, bodies };
}

describe("OpenAIProvider", () => {
  it("sends a strict json_schema Responses request with store:false and routes by task", async () => {
    const { client, bodies } = fakeOpenAI([openaiResponse('{"label":"a","score":0,"note":null}')]);
    const p = new OpenAIProvider(client);
    await p.generate(req("triage"));
    await p.generate(req("draft_reply"));
    await p.generate(
      req("contract_extraction", {
        messages: [
          {
            role: "user",
            content: [
              { type: "pdf", filename: "c.pdf", base64: "JVBERi0=" },
              { type: "text", text: "DATA" },
            ],
          },
        ],
      }),
    );
    expect(bodies[0]).toMatchObject({
      model: "gpt-6-luna",
      instructions: "SYSTEM PROMPT",
      max_output_tokens: 1234,
      store: false,
      reasoning: { effort: "low" },
      text: { format: { type: "json_schema", name: "thing", strict: true, schema: toStrictJsonSchema(schema) } },
      input: [{ role: "user", content: [{ type: "input_text", text: "DATA" }] }],
    });
    expect(bodies.map((b) => b.model)).toEqual(["gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra"]);
    expect(bodies[2]!.input).toEqual([
      {
        role: "user",
        content: [
          { type: "input_file", filename: "c.pdf", file_data: "data:application/pdf;base64,JVBERi0=" },
          { type: "input_text", text: "DATA" },
        ],
      },
    ]);
  });

  it("splits cached tokens out of input tokens so each is priced once", async () => {
    const { client } = fakeOpenAI([openaiResponse('{"label":"a","score":0,"note":null}')]);
    const r = await new OpenAIProvider(client).generate(req("triage"));
    // gpt-6-luna: $0.10 in, $0.01 cached, $0.50 out per MTok: 2000*0.1 + 1000*0.01 + 500*0.5 = 200 + 10 + 250.
    expect(r.usage).toEqual([
      {
        provider: "openai",
        model: "gpt-6-luna",
        inputTokens: 2000,
        outputTokens: 500,
        cacheReadTokens: 1000,
        cacheWriteTokens: 0,
        costMicros: 460,
      },
    ]);
  });

  it("maps incomplete responses to truncated and refusals to refused", async () => {
    const { client } = fakeOpenAI([
      openaiResponse("{", {
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
      } as Partial<Response>),
      openaiResponse("", {
        output: [
          {
            type: "message",
            id: "m",
            role: "assistant",
            status: "completed",
            content: [{ type: "refusal", refusal: "no" }],
          },
        ],
      } as unknown as Partial<Response>),
    ]);
    const p = new OpenAIProvider(client);
    expect(await p.generate(req())).toMatchObject({ ok: false, reason: "truncated" });
    expect(await p.generate(req())).toMatchObject({ ok: false, reason: "refused" });
  });
});

describe("retry and fallback", () => {
  it("retries 429/5xx with backoff, then succeeds", async () => {
    const { client, bodies } = fakeAnthropic([
      apiError(429),
      apiError(503),
      anthropicMessage('{"label":"x","score":1,"note":null}'),
    ]);
    const sleeps: number[] = [];
    const p = new RetryingProvider(new AnthropicProvider(client), {
      ...noSleep,
      baseDelayMs: 100,
      maxDelayMs: 10_000,
      random: () => 0.5,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect((await p.generate(req())).ok).toBe(true);
    expect(bodies).toHaveLength(3);
    expect(sleeps).toEqual([51, 101]); // full jitter over 100ms, then 200ms
  });

  it("does not retry non-retryable errors", async () => {
    const { client, bodies } = fakeAnthropic([apiError(400)]);
    await expect(new RetryingProvider(new AnthropicProvider(client), noSleep).generate(req())).rejects.toThrow(
      ProviderError,
    );
    expect(bodies).toHaveLength(1);
  });

  it("falls back to OpenAI after Anthropic's retries are exhausted", async () => {
    const a = fakeAnthropic([apiError(500)]);
    const o = fakeOpenAI([openaiResponse('{"label":"from-openai","score":1,"note":null}')]);
    const p = createProvider({
      provider: "anthropic",
      anthropicClient: a.client,
      openaiClient: o.client,
      retry: noSleep,
    });
    const r = await p.generate(req());
    expect(r).toMatchObject({ ok: true, value: { label: "from-openai" } });
    expect(a.bodies).toHaveLength(3);
    expect(o.bodies).toHaveLength(1);
    expect(r.usage[0]!.provider).toBe("openai");
  });

  it("does not fall back on invalid output (that is the model's answer, not a provider error)", async () => {
    const a = fakeAnthropic([anthropicMessage("nope")]);
    const o = fakeOpenAI([openaiResponse('{"label":"x","score":1,"note":null}')]);
    const r = await createProvider({
      provider: "anthropic",
      anthropicClient: a.client,
      openaiClient: o.client,
      retry: noSleep,
    }).generate(req());
    expect(r.ok).toBe(false);
    expect(o.bodies).toHaveLength(0);
  });

  it("without an OpenAI key there is no fallback: the provider error surfaces", async () => {
    const a = fakeAnthropic([apiError(500)]);
    const p = createProvider({ provider: "anthropic", anthropicClient: a.client, retry: noSleep });
    expect(p).toBeInstanceOf(RetryingProvider);
    await expect(p.generate(req())).rejects.toMatchObject({ status: 500 });
  });

  it("FallbackProvider reports the primary error", async () => {
    const seen: ProviderError[] = [];
    const failing = {
      name: "anthropic" as const,
      generate: async () => Promise.reject(new ProviderError("down", "anthropic", 503, true)),
    };
    const ok = {
      name: "openai" as const,
      generate: async <T>() => ({ ok: true as const, value: 1 as T, text: "1", usage: [] }),
    };
    await new FallbackProvider(failing, ok, (e) => seen.push(e)).generate(req() as never);
    expect(seen[0]!.status).toBe(503);
  });

  it("requires a key for the chosen provider", () => {
    expect(() => createProvider({ provider: "openai", anthropicApiKey: "k" })).toThrow(/no openai API key/);
  });
});

describe("pricing", () => {
  it("prices every routed model and refuses unknown models", () => {
    for (const m of [
      "claude-haiku-4-5",
      "claude-sonnet-5-5",
      "claude-opus-5-5",
      "gpt-6-luna",
      "gpt-6.1-sol",
      "gpt-6-astra",
    ]) {
      expect(PRICES[m]).toBeDefined();
    }
    expect(() =>
      costMicros("claude-unknown", { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    ).toThrow();
  });

  it("computes Sonnet 5.5 draft cost in integer micro-dollars", () => {
    // 10k uncached in ($2), 10k cache read ($0.20), 1.5k out ($10): 20000 + 2000 + 15000.
    expect(
      costMicros("claude-sonnet-5-5", {
        inputTokens: 10_000,
        outputTokens: 1_500,
        cacheReadTokens: 10_000,
        cacheWriteTokens: 0,
      }),
    ).toBe(37_000);
  });
});

describe("toStrictJsonSchema", () => {
  it("closes every object, requires every key, and strips unsupported constraints", () => {
    const s = toStrictJsonSchema(
      z.object({
        a: z.string().min(2).regex(/x/),
        n: z.object({ b: z.number().int().positive().nullable() }),
        u: z.discriminatedUnion("k", [z.object({ k: z.literal("x") }), z.object({ k: z.literal("y") })]),
      }),
    );
    const text = JSON.stringify(s);
    expect(text).not.toMatch(/minLength|pattern|exclusiveMinimum|maximum|oneOf|\$schema/);
    expect(s).toMatchObject({ type: "object", additionalProperties: false, required: ["a", "n", "u"] });
    expect((s.properties as Record<string, Record<string, unknown>>).n).toMatchObject({
      additionalProperties: false,
      required: ["b"],
    });
    expect(text).toContain('"anyOf"');
  });
});
