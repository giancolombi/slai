import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Loads the repo-root .env (if present) without overriding variables already set. */
export function loadDotenv(): void {
  const path = fileURLToPath(new URL("../../../../.env", import.meta.url));
  if (existsSync(path)) process.loadEnvFile(path);
}
