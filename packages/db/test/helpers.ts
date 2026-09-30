import { randomUUID } from "node:crypto";
import { afterAll } from "vitest";
import { connect, createAuthDb, createOrgDb, createSystemDb } from "../src/client.js";
import { connections, organizations, tickets } from "../src/schema.js";
import { testDbUrls } from "../src/testing.js";

export const urls = testDbUrls("slai_test_db");

/** Connections for one test file: owner (superuser, fixtures only), app (RLS), system and auth. */
export function openDbs() {
  const owner = connect(urls.owner, { max: 2 });
  const app = createOrgDb(urls.app, { max: 4 });
  const system = createSystemDb(urls.system, { max: 2 });
  const auth = createAuthDb(urls.auth, { max: 2 });
  afterAll(async () => {
    await Promise.all([owner.close(), app.close(), system.close(), auth.close()]);
  });
  return { owner, app, system, auth };
}

/** Creates an org with one connection and `n` tickets, as the owner (fixture setup). */
export async function seedOrg(owner: ReturnType<typeof connect>, n = 2) {
  const orgId = randomUUID();
  await owner.db.insert(organizations).values({ id: orgId, name: `Org ${orgId.slice(0, 8)}`, slug: `org-${orgId}` });
  const [conn] = await owner.db
    .insert(connections)
    .values({ orgId, provider: "demo", name: "Demo", credentials: "v1.k1.x.y.z" })
    .returning();
  const now = new Date();
  if (n === 0) return { orgId, connectionId: conn!.id, ticketIds: [] as string[] };
  const rows = await owner.db
    .insert(tickets)
    .values(
      Array.from({ length: n }, (_, i) => ({
        orgId,
        connectionId: conn!.id,
        externalId: `${orgId}-${i}`,
        displayKey: `#${i}`,
        subject: `secret subject ${orgId} ${i}`,
        status: "open" as const,
        createdAtSource: now,
        updatedAtSource: now,
      })),
    )
    .returning();
  return { orgId, connectionId: conn!.id, ticketIds: rows.map((r) => r.id) };
}

/** Awaits a promise that must fail; returns the error text including drizzle's wrapped Postgres cause. */
export async function failure(p: PromiseLike<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const err = e as Error & { cause?: Error };
    return `${err.message} ${err.cause?.message ?? ""}`;
  }
  throw new Error("expected the operation to fail");
}
