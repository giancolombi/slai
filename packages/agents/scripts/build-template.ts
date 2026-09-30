// Builds the E2B sandbox template from sandbox/e2b.Dockerfile and prints the pinned reference.
//
//   pnpm --filter @slai/agents build:sandbox
//   E2B_API_KEY=... pnpm --filter @slai/agents sandbox:template
//
// Pin the printed `slai-agent:<buildId>` as E2B_TEMPLATE. The build id is immutable; names and
// tags are mutable and the runtime refuses them. See the header of sandbox/e2b.Dockerfile.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultBuildLogger, Template } from "e2b";

const sandboxDir = join(dirname(fileURLToPath(import.meta.url)), "../../../sandbox");
if (!existsSync(join(sandboxDir, "dist/runner.js"))) {
  throw new Error("sandbox/dist/runner.js is missing: run `pnpm --filter @slai/agents build:sandbox` first");
}
const apiKey = process.env.E2B_API_KEY;
if (!apiKey) throw new Error("E2B_API_KEY is required");

const template = Template({ fileContextPath: sandboxDir }).fromDockerfile(join(sandboxDir, "e2b.Dockerfile"));
const info = await Template.build(template, process.env.E2B_TEMPLATE_NAME ?? "slai-agent", {
  apiKey,
  cpuCount: 2,
  memoryMB: 2048,
  onBuildLogs: defaultBuildLogger(),
});
console.log(`templateId=${info.templateId}`);
console.log(`E2B_TEMPLATE=${info.name}:${info.buildId}`);
