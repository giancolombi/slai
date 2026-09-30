import { DEMO, DEMO_OTPAUTH_URL, DEMO_TOTP_BASE32, seed } from "../seed.js";
import { loadDotenv } from "./dotenv.js";

loadDotenv();
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
const out = await seed(url);
console.log(`seeded org ${out.orgId}; sign in as ${DEMO.email} / ${DEMO.password}`);
console.log("the demo user is enrolled in TOTP with a fixed DEV-ONLY secret:");
console.log(`  secret (base32): ${DEMO_TOTP_BASE32}`);
console.log(`  otpauth URL:     ${DEMO_OTPAUTH_URL}`);
console.log(`  backup codes:    ${DEMO.backupCodes.join(" ")}`);
console.log("run `pnpm demo:otp` for the current code");
