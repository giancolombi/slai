/**
 * `pnpm keys:rotate [--dry-run]`: re-encrypts every secret under the current
 * ENCRYPTION_KEY_ID. See rotate-keys.ts and TR-27a for the procedure.
 */
import { sql } from "drizzle-orm";
import { connect } from "../client.js";
import { keyringFromEnv } from "../crypto.js";
import { rotateSecrets } from "../rotate-keys.js";
import { loadDotenv } from "./dotenv.js";

loadDotenv();
const ownerUrl = process.env.DATABASE_URL;
const systemUrl = process.env.DATABASE_SYSTEM_URL ?? ownerUrl;
if (!ownerUrl) {
  console.error("DATABASE_URL (the owner role) is not set");
  process.exit(1);
}
const dryRun = process.argv.includes("--dry-run");
const keyring = keyringFromEnv();
const owner = connect(ownerUrl, { max: 2, applicationName: "slai-keys-rotate" });
const system = connect(systemUrl!, { max: 1, applicationName: "slai-keys-rotate" });
try {
  const report = await rotateSecrets({
    owner: owner.db,
    listOrgIds: async () =>
      (await system.db.execute<{ id: string }>(sql`select id::text as id from organizations`)).map((r) => r.id),
    keyring,
    dryRun,
  });
  console.log(JSON.stringify(report, null, 2));
  const left = Object.entries(report.remaining).filter(([, n]) => n > 0);
  if (dryRun) {
    console.log(`dry run: ${left.reduce((s, [, n]) => s + n, 0)} secret(s) would be re-encrypted`);
  } else if (left.length === 0) {
    const old = [...keyring.keys.keys()].filter((id) => id !== keyring.currentId);
    console.log(
      `every secret is under ${keyring.currentId}.${old.length ? ` Key id(s) ${old.join(", ")} can be removed from ENCRYPTION_KEYS_PREVIOUS once every API and worker instance runs with ${keyring.currentId}.` : ""}`,
    );
  } else {
    console.error(`some secrets could not be re-encrypted: ${JSON.stringify(Object.fromEntries(left))}`);
    process.exitCode = 1;
  }
} finally {
  await Promise.all([owner.close(), system.close()]);
}
