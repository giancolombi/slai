/**
 * The narrow sandbox surface the e2b runtime needs, so it can be tested with
 * a fake. `e2bSandboxFactory` adapts the `e2b` SDK (v2) to it.
 * Docs: https://docs.e2b.dev/network/internet-access (egress allowlist and
 * per-host request transforms), https://docs.e2b.dev/template/tags (pinning).
 */
import { ALL_TRAFFIC, CommandExitError, Sandbox, TimeoutError } from "e2b";

export interface SandboxSpec {
  /** Pinned template reference, `name:<buildId>`. */
  template: string;
  /** Sandbox lifetime; E2B kills it at this age even if our kill() is lost. */
  timeoutMs: number;
  metadata: Record<string, string>;
  egress: {
    /** Hostnames the sandbox may reach. Empty = no internet at all. */
    allowHosts: string[];
    /** Headers the egress proxy sets on HTTPS requests to each host (outside the guest). */
    injectHeaders: Record<string, Record<string, string>>;
  };
}

export interface CommandOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class SandboxCommandTimeoutError extends Error {
  override name = "SandboxCommandTimeoutError";
}

export interface SandboxHandle {
  readonly id: string;
  writeFile(path: string, data: string): Promise<void>;
  readFile(path: string): Promise<string>;
  /** Resolves with the exit code (non-zero is not thrown); throws SandboxCommandTimeoutError on timeout. */
  run(cmd: string, opts: { timeoutMs: number; envs: Record<string, string> }): Promise<CommandOutcome>;
  kill(): Promise<void>;
}

export interface SandboxFactory {
  create(spec: SandboxSpec): Promise<SandboxHandle>;
}

export function e2bSandboxFactory(apiKey: string): SandboxFactory {
  return {
    async create(spec) {
      const hosts = spec.egress.allowHosts;
      const sbx = await Sandbox.create(spec.template, {
        apiKey,
        timeoutMs: spec.timeoutMs,
        metadata: spec.metadata,
        ...(hosts.length === 0
          ? { allowInternetAccess: false }
          : {
              network: {
                allowOut: hosts,
                denyOut: [ALL_TRAFFIC],
                rules: Object.fromEntries(
                  Object.entries(spec.egress.injectHeaders).map(([host, headers]) => [
                    host,
                    [{ transform: { headers } }],
                  ]),
                ),
              },
            }),
      });
      return {
        id: sbx.sandboxId,
        async writeFile(path, data) {
          await sbx.files.write(path, data);
        },
        async readFile(path) {
          return sbx.files.read(path);
        },
        async run(cmd, opts) {
          try {
            const r = await sbx.commands.run(cmd, { timeoutMs: opts.timeoutMs, envs: opts.envs });
            return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
          } catch (e) {
            if (e instanceof CommandExitError) return { exitCode: e.exitCode, stdout: e.stdout, stderr: e.stderr };
            if (e instanceof TimeoutError) throw new SandboxCommandTimeoutError(e.message);
            throw e;
          }
        },
        async kill() {
          await sbx.kill();
        },
      };
    },
  };
}
