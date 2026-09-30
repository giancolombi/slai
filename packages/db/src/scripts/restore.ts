/**
 * `pnpm db:restore <file.dump> [--clean] [--target <postgres url>]`: restores a
 * `pnpm db:backup` dump. The target defaults to DATABASE_URL and must be empty
 * unless --clean. A `.sha256` file next to the dump is verified first. After a
 * restore into a new cluster, set the runtime role passwords (ALTER ROLE ...
 * LOGIN PASSWORD) and run `pnpm db:migrate` (a no-op when the dump is current).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { restoreDatabase, sha256File } from "../backup.js";
import { loadDotenv } from "./dotenv.js";

loadDotenv();
const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--target");
const t = args.indexOf("--target");
const url = t >= 0 ? args[t + 1] : process.env.DATABASE_URL;
if (!file || !url) {
  console.error("usage: pnpm db:restore <file.dump> [--clean] [--target <postgres url>] (DATABASE_URL by default)");
  process.exit(1);
}
const path = resolve(file);
if (existsSync(`${path}.sha256`)) {
  const expected = readFileSync(`${path}.sha256`, "utf8").split(/\s+/)[0];
  const actual = await sha256File(path);
  if (expected !== actual) {
    console.error(`checksum mismatch for ${path}: expected ${expected}, got ${actual}`);
    process.exit(1);
  }
  console.log("checksum verified");
}
await restoreDatabase(url, path, { clean: args.includes("--clean") });
console.log(`restored ${path} into ${new URL(url).pathname.slice(1)}`);
