/**
 * Break-glass second-factor reset (T-19, TR-23b): `pnpm auth:break-glass <email> --reason "<ticket, how identity was verified>"`.
 * Needs the database owner's credentials in DATABASE_URL; the runtime roles are refused.
 */
import { parseArgs } from "node:util";
import { breakGlassReset } from "../mfa-reset.js";
import { loadDotenv } from "./dotenv.js";

loadDotenv();
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { reason: { type: "string" }, operator: { type: "string" } },
});
const email = positionals[0];
const url = process.env.DATABASE_URL;
if (!email || !values.reason || !url) {
  console.error('usage: DATABASE_URL=<owner url> pnpm auth:break-glass <email> --reason "<ticket, identity check>"');
  process.exit(1);
}
try {
  const r = await breakGlassReset(url, { email, reason: values.reason, operator: values.operator });
  console.log(
    `reset ${email}: totp=${r.totp} passkeys=${r.passkeys} sessions revoked=${r.sessions}; audited in ${r.orgIds.length} org(s). ` +
      "They enroll a new factor at their next sign-in.",
  );
} catch (e) {
  console.error(`break-glass failed: ${(e as Error).message}`);
  process.exit(1);
}
