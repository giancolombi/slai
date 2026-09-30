// Sandbox entrypoint. Bundled with the agents package into sandbox/dist/runner.js by
// `pnpm --filter @slai/agents build:sandbox`, so the sandbox runs the same agent code as the
// local runtime. Reads /work/manifest.json, writes /work/result.json.
import { main } from "../packages/agents/src/runner.js";

process.exitCode = await main();
