/**
 * Off-site copies of `pnpm db:backup` dumps (T-63, TR-33): upload to an
 * S3-compatible bucket and prune by a grandfather policy. Used by the backup
 * cron service (`db:backup --upload`).
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { DeleteObjectCommand, ListObjectsV2Command, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import type { S3StorageOptions } from "./storage.js";

export interface BackupRetention {
  /** Keep every backup this many days. */
  dailyDays: number;
  /** Beyond that, keep the first backup of each month for this many months. */
  monthlyMonths: number;
}

export const DEFAULT_BACKUP_RETENTION: BackupRetention = { dailyDays: 35, monthlyMonths: 12 };

/** Which backups to delete. Pure: `objects` are keys with their creation time. */
export function backupsToPrune(
  objects: { key: string; at: Date }[],
  now: Date,
  policy: BackupRetention = DEFAULT_BACKUP_RETENTION,
): string[] {
  const dailyCutoff = now.getTime() - policy.dailyDays * 86_400_000;
  const monthlyCutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - policy.monthlyMonths, 1));
  const firstOfMonth = new Map<string, { key: string; at: Date }>();
  for (const o of objects) {
    const m = `${o.at.getUTCFullYear()}-${o.at.getUTCMonth()}`;
    const cur = firstOfMonth.get(m);
    if (!cur || o.at < cur.at) firstOfMonth.set(m, o);
  }
  const keepMonthly = new Set([...firstOfMonth.values()].filter((o) => o.at >= monthlyCutoff).map((o) => o.key));
  return objects.filter((o) => o.at.getTime() < dailyCutoff && !keepMonthly.has(o.key)).map((o) => o.key);
}

export async function uploadBackup(
  s3: S3Client,
  opts: Pick<S3StorageOptions, "bucket" | "sse" | "kmsKeyId">,
  prefix: string,
  file: string,
  sha256: string,
): Promise<string> {
  const key = `${prefix}${basename(file)}`;
  const body = await readFile(file);
  await s3.send(
    new PutObjectCommand({
      Bucket: opts.bucket,
      Key: key,
      Body: body,
      ContentType: "application/octet-stream",
      Metadata: { sha256 },
      ...(opts.sse === "AES256" && { ServerSideEncryption: "AES256" }),
      ...(opts.sse === "aws:kms" && { ServerSideEncryption: "aws:kms", SSEKMSKeyId: opts.kmsKeyId }),
    }),
  );
  return key;
}

/** Lists `prefix`, deletes what the policy drops, and returns the deleted keys. */
export async function pruneBackups(
  s3: S3Client,
  bucket: string,
  prefix: string,
  now: Date,
  policy: BackupRetention = DEFAULT_BACKUP_RETENTION,
): Promise<string[]> {
  const objects: { key: string; at: Date }[] = [];
  let token: string | undefined;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    for (const o of page.Contents ?? []) {
      if (o.Key?.endsWith(".dump") && o.LastModified) objects.push({ key: o.Key, at: o.LastModified });
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  const doomed = backupsToPrune(objects, now, policy);
  for (const key of doomed) await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  return doomed;
}
