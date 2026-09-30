import { seed } from "../seed.js";
import { loadDotenv } from "./dotenv.js";

loadDotenv();
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
const out = await seed(url);
console.log(`seeded org ${out.orgId}; sign in as demo@slai.dev / slai-demo-password-1`);
