import { describe, expect, it } from "vitest";
import { createAgentRuntime } from "../src/index.js";
import { MANIFEST_PATH, RESULT_PATH, RUNNER_COMMAND, type SandboxResult } from "../src/manifest.js";
import { runManifest } from "../src/runner.js";
import { createE2bExecutor, parsePinnedTemplate } from "../src/runtime/e2b.js";
import {
  type CommandOutcome,
  SandboxCommandTimeoutError,
  type SandboxFactory,
  type SandboxHandle,
  type SandboxSpec,
} from "../src/runtime/sandbox.js";
import { okTriage, ticket } from "./helpers.js";

const BUILD = "3f2b8c1e-4d5a-4b6c-9e8f-0a1b2c3d4e5f";
const TEMPLATE = `slai-agent:${BUILD}`;
const ANTHROPIC_KEY = "sk-ant-test-SECRET-anthropic-0001";
const OPENAI_KEY = "sk-proj-test-SECRET-openai-0002";

type RunImpl = (manifest: string, envs: Record<string, string>, sbx: FakeSandbox) => Promise<CommandOutcome>;

/** Runs the real runner code in-process, as the sandbox would. */
const realRunner: RunImpl = async (manifest, envs, sbx) => {
  sbx.files.set(RESULT_PATH, JSON.stringify(await runManifest(manifest, envs)));
  return { exitCode: 0, stdout: "", stderr: "" };
};

const cannedResult =
  (r: SandboxResult): RunImpl =>
  async (_m, _e, sbx) => {
    sbx.files.set(RESULT_PATH, JSON.stringify(r));
    return { exitCode: 0, stdout: "", stderr: "" };
  };

class FakeSandbox implements SandboxHandle {
  files = new Map<string, string>();
  kills = 0;
  runs: { cmd: string; timeoutMs: number; envs: Record<string, string> }[] = [];
  constructor(
    readonly id: string,
    private readonly impl: RunImpl,
    private readonly failWrite = false,
  ) {}
  async writeFile(path: string, data: string) {
    if (this.failWrite) throw new Error("disk full");
    this.files.set(path, data);
  }
  async readFile(path: string) {
    const f = this.files.get(path);
    if (f === undefined) throw new Error(`no such file ${path}`);
    return f;
  }
  async run(cmd: string, opts: { timeoutMs: number; envs: Record<string, string> }) {
    this.runs.push({ cmd, ...opts });
    return this.impl(this.files.get(MANIFEST_PATH)!, opts.envs, this);
  }
  async kill() {
    this.kills++;
  }
}

class FakeFactory implements SandboxFactory {
  specs: SandboxSpec[] = [];
  sandboxes: FakeSandbox[] = [];
  active = 0;
  maxActive = 0;
  constructor(
    private readonly impl: RunImpl = realRunner,
    private readonly opts: { failWrite?: boolean; createDelayMs?: number; failCreate?: boolean } = {},
  ) {}
  async create(spec: SandboxSpec) {
    this.specs.push(spec);
    if (this.opts.createDelayMs) await new Promise((r) => setTimeout(r, this.opts.createDelayMs));
    if (this.opts.failCreate) throw new Error("quota exceeded");
    const sbx = new FakeSandbox(`sbx-${this.sandboxes.length + 1}`, this.impl, this.opts.failWrite);
    this.sandboxes.push(sbx);
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    const kill = sbx.kill.bind(sbx);
    sbx.kill = async () => {
      this.active--;
      await kill();
    };
    return sbx;
  }
}

const e2b = (factory: SandboxFactory, extra: Partial<Parameters<typeof createE2bExecutor>[0]> = {}) =>
  createE2bExecutor({ factory, template: TEMPLATE, provider: "mock", ...extra });
const triageJob = { kind: "triage" as const, input: { ctx: ticket() } };
const bounds = { maxWallMs: 5_000, maxOutputTokens: 4_000, maxModelCalls: 2 };

describe("e2b runtime", () => {
  it("runs the agent in a sandbox, validates the result, meters the sandbox, and kills it", async () => {
    const f = new FakeFactory();
    const r = await e2b(f).run(triageJob, bounds);
    if (!r.ok) throw new Error(r.message);
    expect(r.output.category).toBe("bug");
    expect(r.metering.sandbox).toMatchObject({ id: "sbx-1", templateBuild: BUILD });
    expect(r.metering.sandbox!.seconds).toBeGreaterThanOrEqual(0);
    expect(r.metering.usage).toHaveLength(1);
    const sbx = f.sandboxes[0]!;
    expect(sbx.kills).toBe(1);
    expect(sbx.runs).toEqual([{ cmd: RUNNER_COMMAND, timeoutMs: expect.any(Number), envs: {} }]);
    expect(sbx.runs[0]!.timeoutMs).toBeLessThanOrEqual(bounds.maxWallMs);
    const spec = f.specs[0]!;
    expect(spec.template).toBe(TEMPLATE);
    expect(spec.timeoutMs).toBe(bounds.maxWallMs + 30_000);
    // The mock provider needs no network at all.
    expect(spec.egress).toEqual({ allowHosts: [], injectHeaders: {} });
  });

  it("writes an immutable manifest with the input and bounds", async () => {
    const f = new FakeFactory();
    await e2b(f).run(triageJob, bounds);
    const m = JSON.parse(f.sandboxes[0]!.files.get(MANIFEST_PATH)!);
    expect(m).toMatchObject({ version: 1, job: { kind: "triage" }, bounds, provider: "mock", auth: "egress" });
    expect(m.job.input.ctx.ticketKey).toBe("ZD-4821");
  });

  describe("model keys", () => {
    const withKeys = (mode: "egress" | "env") => {
      const f = new FakeFactory(cannedResult({ ok: true, output: okTriage, usage: [], modelCalls: 1, wallMs: 10 }));
      return {
        f,
        run: e2b(f, {
          provider: "anthropic",
          anthropicApiKey: ANTHROPIC_KEY,
          openaiApiKey: OPENAI_KEY,
          keyInjection: mode,
        }),
      };
    };

    it("egress mode: keys only in the egress proxy rules, never in the manifest or the guest env", async () => {
      const { f, run } = withKeys("egress");
      expect((await run.run(triageJob, bounds)).ok).toBe(true);
      const manifest = f.sandboxes[0]!.files.get(MANIFEST_PATH)!;
      expect(manifest).not.toContain(ANTHROPIC_KEY);
      expect(manifest).not.toContain(OPENAI_KEY);
      expect(JSON.stringify(f.sandboxes[0]!.runs)).not.toMatch(/SECRET/);
      expect(f.specs[0]!.egress).toEqual({
        allowHosts: ["api.anthropic.com", "api.openai.com"],
        injectHeaders: {
          "api.anthropic.com": { "x-api-key": ANTHROPIC_KEY },
          "api.openai.com": { authorization: `Bearer ${OPENAI_KEY}` },
        },
      });
      expect(JSON.parse(manifest)).toMatchObject({ provider: "anthropic", fallbackProvider: "openai", auth: "egress" });
      expect(JSON.stringify(f.specs[0]!.metadata)).not.toMatch(/SECRET/);
    });

    it("env mode: keys only in the runner process env, egress still allowlisted", async () => {
      const { f, run } = withKeys("env");
      await run.run(triageJob, bounds);
      expect(f.sandboxes[0]!.files.get(MANIFEST_PATH)!).not.toMatch(/SECRET/);
      expect(f.sandboxes[0]!.runs[0]!.envs).toEqual({ ANTHROPIC_API_KEY: ANTHROPIC_KEY, OPENAI_API_KEY: OPENAI_KEY });
      expect(f.specs[0]!.egress).toEqual({ allowHosts: ["api.anthropic.com", "api.openai.com"], injectHeaders: {} });
    });

    it("only allowlists the configured provider when there is no fallback key", async () => {
      const f = new FakeFactory(cannedResult({ ok: true, output: okTriage, usage: [], modelCalls: 1, wallMs: 1 }));
      await e2b(f, { provider: "openai", openaiApiKey: OPENAI_KEY }).run(triageJob, bounds);
      expect(f.specs[0]!.egress.allowHosts).toEqual(["api.openai.com"]);
    });

    it("refuses to start without a key for the chosen provider", () => {
      expect(() => e2b(new FakeFactory(), { provider: "anthropic" })).toThrow(/no API key/);
    });
  });

  describe("always kills the sandbox", () => {
    it("on a non-zero runner exit", async () => {
      const f = new FakeFactory(async () => ({ exitCode: 1, stdout: "", stderr: "boom" }));
      const r = await e2b(f).run(triageJob, bounds);
      expect(r).toMatchObject({ ok: false, error: "sandbox_error", message: "runner exited with code 1" });
      expect(f.sandboxes[0]!.kills).toBe(1);
      expect(r.metering.sandbox?.id).toBe("sbx-1");
    });

    it("when the agent fails inside the sandbox", async () => {
      const f = new FakeFactory(
        cannedResult({
          ok: false,
          error: "provider_error",
          message: "anthropic 500",
          usage: [],
          modelCalls: 1,
          wallMs: 5,
        }),
      );
      const r = await e2b(f).run(triageJob, bounds);
      expect(r).toMatchObject({ ok: false, error: "provider_error", message: "anthropic 500" });
      expect(f.sandboxes[0]!.kills).toBe(1);
    });

    it("when writing the manifest throws", async () => {
      const f = new FakeFactory(realRunner, { failWrite: true });
      const r = await e2b(f).run(triageJob, bounds);
      expect(r).toMatchObject({ ok: false, error: "sandbox_error", message: "disk full" });
      expect(f.sandboxes[0]!.kills).toBe(1);
    });

    it("on a garbage or missing result file", async () => {
      for (const impl of [
        async (_m: string, _e: Record<string, string>, s: FakeSandbox) => {
          s.files.set(RESULT_PATH, "{not json");
          return { exitCode: 0, stdout: "", stderr: "" };
        },
        async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        cannedResult({ ok: true, output: okTriage, usage: [], modelCalls: 1, wallMs: 1, extra: 1 } as SandboxResult),
      ] as RunImpl[]) {
        const f = new FakeFactory(impl);
        const r = await e2b(f).run(triageJob, bounds);
        expect(r).toMatchObject({ ok: false, error: "sandbox_error" });
        expect(f.sandboxes[0]!.kills).toBe(1);
      }
    });

    it("on a run that hangs past the wall-time bound", async () => {
      const f = new FakeFactory(() => new Promise<never>(() => {}));
      const r = await e2b(f).run(triageJob, { ...bounds, maxWallMs: 50 });
      expect(r).toMatchObject({ ok: false, error: "bound_exceeded" });
      expect(f.sandboxes[0]!.kills).toBe(1);
    });

    it("when the command itself times out", async () => {
      const f = new FakeFactory(async () => {
        throw new SandboxCommandTimeoutError("deadline_exceeded");
      });
      const r = await e2b(f).run(triageJob, bounds);
      expect(r).toMatchObject({ ok: false, error: "bound_exceeded" });
      expect(f.sandboxes[0]!.kills).toBe(1);
    });

    it("when the sandbox only becomes ready after the run timed out", async () => {
      const f = new FakeFactory(realRunner, { createDelayMs: 80 });
      const r = await e2b(f).run(triageJob, { ...bounds, maxWallMs: 20 });
      expect(r).toMatchObject({ ok: false, error: "bound_exceeded" });
      await new Promise((res) => setTimeout(res, 120));
      expect(f.sandboxes[0]!.kills).toBe(1);
      expect(f.sandboxes[0]!.runs).toHaveLength(0);
    });

    it("reports a create failure without a sandbox to kill", async () => {
      const f = new FakeFactory(realRunner, { failCreate: true });
      const r = await e2b(f).run(triageJob, bounds);
      expect(r).toMatchObject({ ok: false, error: "sandbox_error", message: "quota exceeded" });
      expect(r.metering.sandbox).toBeNull();
    });
  });

  describe("bounds are enforced on the host", () => {
    const usage = (outputTokens: number) => ({
      provider: "anthropic" as const,
      model: "claude-haiku-4-5",
      inputTokens: 1000,
      outputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costMicros: 0,
    });

    it("too many model calls is a failed run even if the guest reports success", async () => {
      const f = new FakeFactory(
        cannedResult({ ok: true, output: okTriage, usage: [usage(10)], modelCalls: 3, wallMs: 1 }),
      );
      const r = await e2b(f).run(triageJob, bounds);
      expect(r).toMatchObject({ ok: false, error: "bound_exceeded", message: "model calls 3 > 2" });
      expect(r.metering.usage).toHaveLength(1); // still metered
    });

    it("too many output tokens is a failed run", async () => {
      const f = new FakeFactory(
        cannedResult({ ok: true, output: okTriage, usage: [usage(4_001)], modelCalls: 1, wallMs: 1 }),
      );
      const r = await e2b(f).run(triageJob, bounds);
      expect(r).toMatchObject({ ok: false, error: "bound_exceeded" });
    });

    it("the guest's cost figure is ignored; cost is recomputed from tokens on the host", async () => {
      const f = new FakeFactory(
        cannedResult({
          ok: true,
          output: okTriage,
          usage: [{ ...usage(200), costMicros: 1 }],
          modelCalls: 1,
          wallMs: 1,
        }),
      );
      const r = await e2b(f).run(triageJob, bounds);
      expect(r.metering.usage[0]!.costMicros).toBe(1000 * 1 + 200 * 5);
    });

    it("output that fails the worker-side schema is invalid_output", async () => {
      const f = new FakeFactory(
        cannedResult({ ok: true, output: { ...okTriage, confidence: 9 }, usage: [], modelCalls: 1, wallMs: 1 }),
      );
      expect(await e2b(f).run(triageJob, bounds)).toMatchObject({ ok: false, error: "invalid_output" });
    });

    it("a bound hit inside the sandbox is propagated", async () => {
      const f = new FakeFactory();
      const r = await e2b(f).run(triageJob, { ...bounds, maxOutputTokens: 5 });
      expect(r).toMatchObject({ ok: false, error: "bound_exceeded" });
      expect(f.sandboxes[0]!.kills).toBe(1);
    });
  });

  it("limits concurrent sandboxes and queues the rest", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const f = new FakeFactory(async (m, e, s) => {
      await gate;
      return realRunner(m, e, s);
    });
    const exec = e2b(f, { concurrency: 2 });
    const runs = Array.from({ length: 5 }, () => exec.run(triageJob, bounds));
    await new Promise((r) => setTimeout(r, 20));
    expect(f.active).toBe(2);
    expect(exec.limiter.pending).toBe(3);
    release();
    const results = await Promise.all(runs);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(f.maxActive).toBe(2);
    expect(f.sandboxes.every((s) => s.kills === 1)).toBe(true);
  });

  it("defaults to 20 concurrent sandboxes", () => {
    expect(() => e2b(new FakeFactory())).not.toThrow();
  });
});

describe("template pinning", () => {
  it("accepts name:<buildId> and rejects names and mutable tags", () => {
    expect(parsePinnedTemplate(TEMPLATE)).toEqual({ name: "slai-agent", buildId: BUILD });
    expect(parsePinnedTemplate(`team/slai-agent:${BUILD}`).name).toBe("team/slai-agent");
    for (const bad of [
      "slai-agent",
      "slai-agent:latest",
      "slai-agent:default",
      "slai-agent:v1.2",
      `slai-agent:${BUILD}x`,
    ]) {
      expect(() => parsePinnedTemplate(bad), bad).toThrow(/not pinned/);
    }
  });
});

describe("createAgentRuntime (e2b)", () => {
  it("runs through an injected SandboxFactory with default bounds", async () => {
    const f = new FakeFactory();
    const rt = createAgentRuntime({ runtime: "e2b", provider: "mock", e2bTemplate: TEMPLATE, sandboxFactory: f });
    const r = await rt.draftReply(ticket(), okTriage);
    expect(r.ok).toBe(true);
    expect(JSON.parse(f.sandboxes[0]!.files.get(MANIFEST_PATH)!).bounds).toEqual({
      maxWallMs: 120_000,
      maxOutputTokens: 16_000,
      maxModelCalls: 2,
    });
  });

  it("requires a pinned template and an E2B key", () => {
    expect(() => createAgentRuntime({ runtime: "e2b", provider: "mock" })).toThrow(/E2B_TEMPLATE/);
    expect(() => createAgentRuntime({ runtime: "e2b", provider: "mock", e2bTemplate: TEMPLATE })).toThrow(
      /E2B_API_KEY/,
    );
    expect(() =>
      createAgentRuntime({
        runtime: "e2b",
        provider: "mock",
        e2bTemplate: "slai-agent",
        sandboxFactory: new FakeFactory(),
      }),
    ).toThrow(/not pinned/);
  });
});
