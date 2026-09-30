import { createTestDatabase } from "@slai/db";

export default async function setup() {
  await createTestDatabase("slai_test_worker");
}
