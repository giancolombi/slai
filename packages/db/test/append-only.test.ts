import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { audit } from "../src/audit.js";
import { auditEvents, usageLedger } from "../src/schema.js";
import { failure, openDbs, seedOrg } from "./helpers.js";

const { owner, app } = openDbs();
let orgId: string;

beforeAll(async () => {
  ({ orgId } = await seedOrg(owner, 0));
  await app.withOrg(orgId, (tx) =>
    audit(tx, {
      orgId,
      actor: { type: "user", id: null, name: "Test" },
      action: "policy.approved",
      target: { type: "policy", id: "p1" },
      metadata: { version: 2 },
    }),
  );
  await app.withOrg(orgId, (tx) =>
    tx.insert(usageLedger).values({ orgId, kind: "model_call", quantity: 10, unit: "tokens" }),
  );
});

describe("audit_events is append-only", () => {
  it("records the event, visible only within its org", async () => {
    const rows = await app.withOrg(orgId, (tx) => tx.select().from(auditEvents));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "policy.approved", actorType: "user", metadata: { version: 2 } });
  });

  it("rejects UPDATE, even for the owner role", async () => {
    expect(
      await failure(owner.db.update(auditEvents).set({ action: "x" }).where(eq(auditEvents.orgId, orgId))),
    ).toMatch(/append-only/);
    expect(
      await failure(
        app.withOrg(orgId, (tx) => tx.update(auditEvents).set({ action: "x" }).where(eq(auditEvents.orgId, orgId))),
      ),
    ).toMatch(/permission denied|append-only/);
  });

  it("rejects DELETE, even for the owner role", async () => {
    expect(await failure(owner.db.delete(auditEvents).where(eq(auditEvents.orgId, orgId)))).toMatch(/append-only/);
    expect(
      await failure(app.withOrg(orgId, (tx) => tx.delete(auditEvents).where(eq(auditEvents.orgId, orgId)))),
    ).toMatch(/permission denied|append-only/);
  });

  it("rejects TRUNCATE", async () => {
    expect(await failure(owner.client`truncate audit_events`)).toMatch(/append-only/);
  });
});

describe("usage_ledger is append-only", () => {
  it("rejects UPDATE and DELETE", async () => {
    expect(
      await failure(owner.db.update(usageLedger).set({ quantity: 0 }).where(eq(usageLedger.orgId, orgId))),
    ).toMatch(/append-only/);
    expect(await failure(owner.db.delete(usageLedger).where(eq(usageLedger.orgId, orgId)))).toMatch(/append-only/);
  });
});
