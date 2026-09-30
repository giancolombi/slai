import { createTestDatabase } from "../src/testing.js";

export const TEST_DB = "slai_test_db";

export default async function setup() {
  await createTestDatabase(TEST_DB);
}
