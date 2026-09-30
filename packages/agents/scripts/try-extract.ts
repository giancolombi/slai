/**
 * Runs contract extraction on a local file and prints the result summary.
 *   pnpm --filter @slai/agents exec tsx scripts/try-extract.ts <file> [provider]
 * provider: mock | ollama | anthropic | openai (keys from env).
 */
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { createAgentRuntime, type ModelProvider } from "../src/index.js";

const file = process.argv[2];
if (!file) throw new Error("usage: try-extract.ts <file> [provider]");
const provider = (process.argv[3] ?? process.env.MODEL_PROVIDER ?? "mock") as ModelProvider;
const mediaType =
  (
    {
      ".pdf": "application/pdf",
      ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ".md": "text/markdown",
    } as const
  )[extname(file).toLowerCase() as ".pdf"] ?? "text/plain";

const rt = createAgentRuntime({
  runtime: "local",
  provider,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  openaiApiKey: process.env.OPENAI_API_KEY,
  ollamaUrl: process.env.OLLAMA_URL,
  ollamaModel: process.env.OLLAMA_MODEL,
});
const started = Date.now();
const res = await rt.extractContract(
  [{ filename: file.split("/").pop()!, mediaType, base64: readFileSync(file).toString("base64") }],
  { maxWallMs: 15 * 60_000 },
);
console.log(JSON.stringify({ seconds: Math.round((Date.now() - started) / 1000), ...res }, null, 2));
