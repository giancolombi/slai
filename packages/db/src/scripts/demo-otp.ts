/** Prints the demo user's current TOTP code (from the seed's fixed, dev-only secret). */
import { DEMO, DEMO_TOTP_BASE32 } from "../seed.js";
import { STEP_SECONDS, totp } from "../totp.js";

const now = new Date();
const left = STEP_SECONDS - (Math.floor(now.getTime() / 1000) % STEP_SECONDS);
console.log(`${totp(DEMO_TOTP_BASE32, now)}  (${DEMO.email}, valid for ${left}s more)`);
