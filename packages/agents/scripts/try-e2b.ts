/**
 * Runs one triage and one contract extraction in real E2B sandboxes and prints
 * the metering, to verify the sandbox path end to end.
 *   E2B_API_KEY=... E2B_TEMPLATE=slai-agent:<buildId> pnpm --filter @slai/agents exec tsx scripts/try-e2b.ts [provider]
 */
import { readFileSync } from "node:fs";
import { createAgentRuntime, type ModelProvider } from "../src/index.js";

const provider = (process.argv[2] ?? "mock") as ModelProvider;
const rt = createAgentRuntime({
  runtime: "e2b",
  provider,
  e2bApiKey: process.env.E2B_API_KEY,
  e2bTemplate: process.env.E2B_TEMPLATE,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  openaiApiKey: process.env.OPENAI_API_KEY,
});

const triage = await rt.triage({
  ticketKey: "#1001",
  subject: "SSO login loop after certificate rotation",
  priority: "high",
  status: "open",
  customerName: "Northwind Analytics",
  thread: [
    {
      at: new Date().toISOString(),
      authorRole: "requester",
      authorName: "Priya",
      public: true,
      body: "Since this morning all our users get bounced back to the login page after Okta. Urgent: nobody can work.",
    },
  ],
  sla: { risk: "at_risk", mostUrgent: null, metrics: ["first_response", "resolution"] },
  knowledge: [],
  assignees: [{ sourceId: "u1", name: "Dana", skills: ["sso", "auth"] }],
});
console.log(
  "triage:",
  JSON.stringify({ ok: triage.ok, metering: triage.metering, out: triage.ok ? triage.output : triage }, null, 1).slice(
    0,
    1200,
  ),
);

const file = new URL("../test/fixtures/globex-exhibit.pdf", import.meta.url);
const extract = await rt.extractContract([
  { filename: "globex-exhibit.pdf", mediaType: "application/pdf", base64: readFileSync(file).toString("base64") },
]);
console.log(
  "extract:",
  JSON.stringify({
    ok: extract.ok,
    metering: extract.metering,
    policies: extract.ok ? extract.output.policies.map((p) => p.name) : extract,
  }).slice(0, 1200),
);
