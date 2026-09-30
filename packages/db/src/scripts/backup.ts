/**
 * `pnpm db:backup [--out <file|dir>] [--upload]`: a pg_dump custom-format
 * backup of DATABASE_URL (the owner role), plus a `.sha256` file next to it.
 * Default directory: BACKUP_DIR or .data/backups.
 *
 * `--upload` copies it to an S3-compatible bucket (BACKUP_S3_BUCKET, else
 * S3_BUCKET, with the other S3_* settings; key prefix BACKUP_S3_PREFIX,
 * default `backups/`) and prunes old copies: every backup for
 * BACKUP_KEEP_DAILY_DAYS (35), then the first of each month for
 * BACKUP_KEEP_MONTHLY_MONTHS (12). See TR-33.
 */
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { backupDatabase, backupFileName } from "../backup.js";
import { DEFAULT_BACKUP_RETENTION, pruneBackups, uploadBackup } from "../backup-offsite.js";
import { resolveFromRepoRoot, s3Client, s3OptionsFromEnv } from "../storage.js";
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

if (process.argv.includes("--upload")) {
  const opts = s3OptionsFromEnv({ ...process.env, S3_BUCKET: process.env.BACKUP_S3_BUCKET || process.env.S3_BUCKET });
  const prefix = process.env.BACKUP_S3_PREFIX ?? "backups/";
  const s3 = s3Client(opts);
  try {
    const key = await uploadBackup(s3, opts, prefix, out.file, out.sha256);
    console.log(`uploaded to s3://${opts.bucket}/${key}`);
    const deleted = await pruneBackups(s3, opts.bucket, prefix, new Date(), {
      dailyDays: Number(process.env.BACKUP_KEEP_DAILY_DAYS ?? DEFAULT_BACKUP_RETENTION.dailyDays),
      monthlyMonths: Number(process.env.BACKUP_KEEP_MONTHLY_MONTHS ?? DEFAULT_BACKUP_RETENTION.monthlyMonths),
    });
    console.log(`pruned ${deleted.length} old backup(s)`);
  } finally {
    s3.destroy();
  }
}
