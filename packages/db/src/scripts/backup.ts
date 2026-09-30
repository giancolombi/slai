/**
 * `pnpm db:backup [--out <file|dir>]`: a pg_dump custom-format backup of
 * DATABASE_URL (the owner role), plus a `.sha256` file next to it. Default
 * directory: BACKUP_DIR or .data/backups. See TR-33 for where backups go and
 * how long they are kept.
 */
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { backupDatabase, backupFileName } from "../backup.js";
import { resolveFromRepoRoot } from "../storage.js";
import { loadDotenv } from "./dotenv.js";

loadDotenv();
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
const i = process.argv.indexOf("--out");
const target = i > 0 ? resolve(process.argv[i + 1]!) : resolveFromRepoRoot(process.env.BACKUP_DIR ?? ".data/backups");
const isDir = !target.endsWith(".dump") || (await stat(target).catch(() => null))?.isDirectory();
const file = isDir ? join(target, backupFileName()) : target;
await mkdir(isDir ? target : resolve(file, ".."), { recursive: true, mode: 0o700 });
const out = await backupDatabase(url, file);
await writeFile(`${out.file}.sha256`, `${out.sha256}  ${out.file.split("/").pop()}\n`, { mode: 0o600 });
console.log(`backup written: ${out.file} (sha256 ${out.sha256})`);
