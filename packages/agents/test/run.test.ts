import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAgentRuntime } from "../src/index.js";
import type { Manifest } from "../src/manifest.js";
import { ProviderError } from "../src/providers/types.js";
import { resolveBounds } from "../src/run.js";
import { main, runManifest } from "../src/runner.js";
import { answer, okTriage, ScriptedProvider, ticket } from "./helpers.js";

const local = (p: ScriptedProvider) => createAgentRuntime({ runtime: "local", provider: "anthropic", llm: p });

describe("local runtime bounds", () => {
  it("fails a run that exceeds wall time, whatever the provider does", async () => {
    const hang = new ScriptedProvider([() => new Promise(() => {})]);
    const r = await local(hang).triage(ticket(), { maxWallMs: 30 });
    expect(r).toMatchObject({ ok: false, error: "bound_exceeded" });
    expect(r.metering.wallMs).toBeGreaterThanOrEqual(25);
  });

  it("aborts the in-flight request when the wall time is hit", async () => {
    let signal: AbortSignal | undefined;
    const p = new ScriptedProvider([
      (req) => {
        signal = req.signal;
        return new Promise(() => {});
      },
    ]);
    await local(p).triage(ticket(), { maxWallMs: 20 });
    expect(signal?.aborted).toBe(true);
  });

  it("fails a run whose output tokens exceed the bound (never a partial success)", async () => {
    const r = await local(new ScriptedProvider([answer(okTriage, 5_000)])).triage(ticket(), { maxOutputTokens: 4_000 });
    expect(r).toMatchObject({ ok: false, error: "bound_exceeded" });
    expect(r.metering.usage).toHaveLength(1);
  });

  it("caps each call's max tokens at what is left of the run's budget", async () => {
    const p = new ScriptedProvider([answer(okTriage)]);
    await local(p).triage(ticket(), { maxOutputTokens: 700 });
    expect(p.requests[0]!.maxOutputTokens).toBe(700);
  });

  it("maps provider errors and keeps their metering", async () => {
    const p = new ScriptedProvider([
      () => Promise.reject(new ProviderError("anthropic 529 error: overloaded", "anthropic", 529, true)),
    ]);
    expect(await local(p).triage(ticket())).toMatchObject({ ok: false, error: "provider_error", message: /529/ });
  });

  it("reports an unreadable document as an error rather than throwing", async () => {
    const r = await createAgentRuntime({ runtime: "local", provider: "mock" }).extractContract([
      { filename: "bad.pdf", mediaType: "application/pdf", base64: Buffer.from("not a pdf").toString("base64") },
    ]);
    expect(r).toMatchObject({ ok: false, error: "provider_error", message: /agent error/ });
  });

  it("resolves partial bounds over per-kind defaults and rejects nonsense", () => {
    expect(resolveBounds("triage", { maxModelCalls: 1, maxWallMs: undefined })).toEqual({
      maxWallMs: 60_000,
      maxOutputTokens: 4_000,
      maxModelCalls: 1,
    });
    expect(() => resolveBounds("triage", { maxWallMs: -1 })).toThrow();
  });
});

describe("sandbox runner", () => {
  const manifest: Manifest = {
    version: 1,
    runId: "run-1",
    job: { kind: "triage", input: { ctx: ticket() } },
    bounds: { maxWallMs: 10_000, maxOutputTokens: 4_000, maxModelCalls: 2 },
    provider: "mock",
    fallbackProvider: null,
    auth: "egress",
  };

  it("runs the manifest's job and reports usage and model calls", async () => {
    const r = await runManifest(JSON.stringify(manifest), {});
    expect(r).toMatchObject({ ok: true, modelCalls: 1, output: { category: "bug" } });
  });

  it("rejects a malformed manifest", async () => {
    const r = await runManifest(JSON.stringify({ ...manifest, version: 2 }), {});
    expect(r).toMatchObject({ ok: false, error: "sandbox_error", message: /bad manifest/ });
  });

  it("main() reads the manifest file and writes the result file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "slai-runner-"));
    const m = join(dir, "manifest.json");
    const out = join(dir, "result.json");
    writeFileSync(m, JSON.stringify(manifest));
    expect(await main({ SLAI_MANIFEST_PATH: m, SLAI_RESULT_PATH: out })).toBe(0);
    expect(JSON.parse(readFileSync(out, "utf8"))).toMatchObject({ ok: true });
    await main({ SLAI_MANIFEST_PATH: join(dir, "missing.json"), SLAI_RESULT_PATH: out });
    expect(JSON.parse(readFileSync(out, "utf8"))).toMatchObject({ ok: false, error: "sandbox_error" });
  });
});
