import { runMigrations } from "../migrate.js";
import { loadDotenv } from "./dotenv.js";

loadDotenv();
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
await runMigrations(url);
console.log("migrations applied");
