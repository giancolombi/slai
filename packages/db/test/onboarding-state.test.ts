import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { onboardingState, users } from "../src/schema.js";
import { failure, openDbs, seedOrg } from "./helpers.js";

const { owner, app, system, auth } = openDbs();
let a: Awaited<ReturnType<typeof seedOrg>>;
let b: Awaited<ReturnType<typeof seedOrg>>;
let userId: string;

beforeAll(async () => {
  a = await seedOrg(owner, 0);
  b = await seedOrg(owner, 0);
  const [u] = await owner.db
    .insert(users)
    .values({ email: `onb-${randomUUID()}@example.com`, name: "Onb" })
    .returning();
  userId = u!.id;
  // The same user has preferences in both orgs.
  await owner.db.insert(onboardingState).values([
    { orgId: a.orgId, userId, checklistDismissedAt: new Date() },
    { orgId: b.orgId, userId, welcomeSeenAt: new Date() },
  ]);
});

describe("onboarding_state row-level security", () => {
  it("each org sees only its own rows, even for the same user", async () => {
    const rowsA = await app.withOrg(a.orgId, (tx) => tx.select().from(onboardingState));
    expect(rowsA.map((r) => r.orgId)).toEqual([a.orgId]);
    expect(rowsA[0]!.checklistDismissedAt).not.toBeNull();
    const rowsB = await app.withOrg(b.orgId, (tx) => tx.select().from(onboardingState));
    expect(rowsB.map((r) => r.orgId)).toEqual([b.orgId]);
    expect(rowsB[0]!.checklistDismissedAt).toBeNull();
  });

  it("org A cannot write or delete org B's preferences", async () => {
    expect(
      await failure(app.withOrg(a.orgId, (tx) => tx.insert(onboardingState).values({ orgId: b.orgId, userId }))),
    ).toMatch(/row-level security/);
    const updated = await app.withOrg(a.orgId, (tx) =>
      tx.update(onboardingState).set({ checklistDismissedAt: new Date() }).returning(),
    );
    expect(updated.map((r) => r.orgId)).toEqual([a.orgId]);
    const deleted = await app.withOrg(a.orgId, (tx) => tx.delete(onboardingState).returning());
    expect(deleted.map((r) => r.orgId)).toEqual([a.orgId]);
    const stillB = await owner.db.select().from(onboardingState);
    expect(stillB.some((r) => r.orgId === b.orgId)).toBe(true);
  });

  it("nothing outside withOrg, and no other runtime role can read it", async () => {
    expect(await app.db.select().from(onboardingState)).toEqual([]);
    expect(await failure(system.client`select * from onboarding_state`)).toMatch(/permission denied/);
    expect(await failure(auth.client`select * from onboarding_state`)).toMatch(/permission denied/);
  });
});
