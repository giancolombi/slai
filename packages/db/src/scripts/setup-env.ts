/**
 * Creates the repo-root .env from .env.example, generating ENCRYPTION_KEY and
 * SESSION_SECRET. Existing non-empty values in .env are kept, so rerunning is safe.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = (p: string) => fileURLToPath(new URL(`../../../../${p}`, import.meta.url));
const example = readFileSync(root(".env.example"), "utf8");
const current = existsSync(root(".env")) ? readFileSync(root(".env"), "utf8") : "";

const existing = new Map<string, string>();
for (const line of current.split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (m?.[2]) existing.set(m[1]!, m[2]);
}
const generated: Record<string, () => string> = {
  ENCRYPTION_KEY: () => randomBytes(32).toString("base64"),
  SESSION_SECRET: () => randomBytes(32).toString("base64"),
};

const out = example.split("\n").map((line) => {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (!m) return line;
  const key = m[1]!;
  const keep = existing.get(key);
  if (keep) return `${key}=${keep}`;
  const gen = generated[key];
  return gen && !m[2] ? `${key}=${gen()}` : line;
});
writeFileSync(root(".env"), out.join("\n"), { mode: 0o600 });
console.log(`wrote ${root(".env")}`);
