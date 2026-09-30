/**
 * The s3 storage driver against a real S3-compatible server (MinIO). Start one
 * with `docker compose -f docker-compose.prod.yml up -d minio` or point
 * S3_TEST_ENDPOINT at any MinIO. Skipped when none is reachable, unless
 * S3_TEST_REQUIRED=1 (CI runs MinIO, so there it must pass).
 */
import { randomUUID } from "node:crypto";
import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { createS3Storage, ensureS3Bucket, type S3StorageOptions, s3Client } from "../src/storage.js";

const endpoint = process.env.S3_TEST_ENDPOINT ?? "http://localhost:9000";
const opts: S3StorageOptions = {
  bucket: process.env.S3_TEST_BUCKET ?? "slai-test",
  region: "us-east-1",
  endpoint,
  forcePathStyle: true,
  accessKeyId: process.env.S3_TEST_ACCESS_KEY_ID ?? "slai-minio",
  secretAccessKey: process.env.S3_TEST_SECRET_ACCESS_KEY ?? "slai-minio-secret",
  sse: "AES256",
  prefix: `test-${randomUUID()}/`,
};

async function reachable(): Promise<boolean> {
  try {
    const res = await fetch(`${endpoint}/minio/health/live`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

const up = await reachable();
if (!up && process.env.S3_TEST_REQUIRED === "1") throw new Error(`S3_TEST_REQUIRED=1 but ${endpoint} is unreachable`);

describe.skipIf(!up)("s3 storage driver (MinIO)", () => {
  const storage = createS3Storage(opts);
  const bytes = new TextEncoder().encode("%PDF-1.7 master services agreement");

  it("round-trips an object with its content type, sha256 metadata and server-side encryption", async () => {
    await ensureS3Bucket(opts);
    const key = `${randomUUID()}/contracts/${randomUUID()}`;
    await storage.put(key, bytes, { contentType: "application/pdf", sha256: "abc123" });
    expect(Buffer.from(await storage.get(key)).toString()).toBe("%PDF-1.7 master services agreement");

    const client = s3Client(opts);
    const head = await client.send(new HeadObjectCommand({ Bucket: opts.bucket, Key: `${opts.prefix}${key}` }));
    client.destroy();
    expect(head.ContentType).toBe("application/pdf");
    expect(head.Metadata?.sha256).toBe("abc123");
    expect(head.ServerSideEncryption).toBe("AES256");
  });

  it("is write-once: a second put to the same key is refused", async () => {
    const key = `${randomUUID()}/contracts/${randomUUID()}`;
    await storage.put(key, bytes, { contentType: "application/pdf", sha256: "x" });
    await expect(storage.put(key, bytes, { contentType: "application/pdf", sha256: "y" })).rejects.toThrow();
  });

  it("deletes objects, idempotently", async () => {
    const key = `${randomUUID()}/exports/${randomUUID()}.tar.gz`;
    await storage.put(key, bytes, { contentType: "application/gzip", sha256: "x" });
    await storage.delete(key);
    await expect(storage.get(key)).rejects.toThrow();
    await storage.delete(key);
  });

  it("rejects keys that could escape the prefix", async () => {
    await expect(storage.put("../other-tenant/x", bytes, { contentType: "text/plain", sha256: "x" })).rejects.toThrow(
      "invalid storage key",
    );
    await expect(storage.get("/abs")).rejects.toThrow("invalid storage key");
  });
});
