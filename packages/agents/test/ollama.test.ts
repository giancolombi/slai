import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createProvider, OllamaProvider } from "../src/providers/index.js";
import { ProviderError } from "../src/providers/types.js";

const schema = z.object({ answer: z.string(), confidence: z.number() });

function fakeFetch(respond: (body: any) => { status?: number; json: unknown }) {
  const calls: { url: string; body: any }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url, body });
    const r = respond(body);
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const req = {
  task: "triage" as const,
  system: "You are careful.",
  messages: [
    {
      role: "user" as const,
      content: [
        { type: "pdf" as const, filename: "c.pdf", base64: "JVBERi0=" },
        { type: "text" as const, text: "<data>hello</data>" },
      ],
    },
  ],
  schemaName: "t",
  schema,
  maxOutputTokens: 500,
};

describe("OllamaProvider", () => {
  it("sends a JSON-schema constrained chat without PDFs and meters zero cost", async () => {
    const { fn, calls } = fakeFetch(() => ({
      json: {
        message: { content: '{"answer":"hi","confidence":0.9}' },
        done_reason: "stop",
        prompt_eval_count: 120,
        eval_count: 14,
      },
    }));
    const p = new OllamaProvider({ baseUrl: "http://localhost:11434/", model: "qwen3.5:9b", fetch: fn });
    const out = await p.generate(req);
    expect(out).toMatchObject({ ok: true, value: { answer: "hi", confidence: 0.9 } });
    expect(out.usage).toEqual([
      {
        provider: "ollama",
        model: "qwen3.5:9b",
        inputTokens: 120,
        outputTokens: 14,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costMicros: 0,
      },
    ]);
    const [call] = calls;
    expect(call!.url).toBe("http://localhost:11434/api/chat");
    expect(call!.body).toMatchObject({
      model: "qwen3.5:9b",
      stream: false,
      options: { temperature: 0, num_predict: 500 },
    });
    expect(call!.body.format).toMatchObject({ type: "object", required: ["answer", "confidence"] });
    expect(call!.body.messages).toEqual([
      { role: "system", content: "You are careful." },
      { role: "user", content: "<data>hello</data>" },
    ]);
  });

  it("reports truncation and schema failures like other providers", async () => {
    const trunc = new OllamaProvider({
      baseUrl: "http://x",
      model: "m",
      fetch: fakeFetch(() => ({ json: { message: { content: '{"ans' }, done_reason: "length" } })).fn,
    });
    expect(await trunc.generate(req)).toMatchObject({ ok: false, reason: "truncated" });
    const bad = new OllamaProvider({
      baseUrl: "http://x",
      model: "m",
      fetch: fakeFetch(() => ({ json: { message: { content: '{"answer":1}' }, done_reason: "stop" } })).fn,
    });
    expect(await bad.generate(req)).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("raises a retryable ProviderError when Ollama is down, with a hint", async () => {
    const down = new OllamaProvider({
      baseUrl: "http://localhost:11434",
      model: "m",
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    const err = await down.generate(req).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.retryable).toBe(true);
    expect(err.message).toMatch(/ollama serve/);
  });

  it("is selected by MODEL_PROVIDER=ollama without any API key", async () => {
    const { fn, calls } = fakeFetch(() => ({
      json: { message: { content: '{"answer":"ok","confidence":1}' }, done_reason: "stop" },
    }));
    const p = createProvider({
      provider: "ollama",
      fetch: fn,
      retry: { retries: 0, baseDelayMs: 0, maxDelayMs: 0, sleep: async () => {}, random: () => 0 },
    });
    expect(await p.generate(req)).toMatchObject({ ok: true });
    expect(calls[0]!.body.model).toBe("qwen3.5:9b");
  });
});
