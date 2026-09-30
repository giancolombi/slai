import { runMigrations, syncRolePasswords } from "../migrate.js";
import { assertProductionEnv } from "../prod-env.js";
import { ensureS3Bucket, s3OptionsFromEnv } from "../storage.js";
import { loadDotenv } from "./dotenv.js";

loadDotenv();
assertProductionEnv(process.env, "migrate");
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
await runMigrations(url);
console.log("migrations applied");
if (process.env.MIGRATE_SET_ROLE_PASSWORDS === "true") {
  const urls = ["DATABASE_APP_URL", "DATABASE_SYSTEM_URL", "DATABASE_AUTH_URL"]
    .map((k) => process.env[k])
    .filter((u): u is string => !!u);
  const roles = await syncRolePasswords(url, urls);
  console.log(`role passwords set from their URLs: ${roles.join(", ") || "none"}`);
}
// Local and staging only: production buckets are created by infrastructure code.
if (process.env.STORAGE_DRIVER === "s3" && process.env.STORAGE_ENSURE_BUCKET === "true") {
  await ensureS3Bucket(s3OptionsFromEnv());
  console.log(`bucket ${process.env.S3_BUCKET} ready`);
}
