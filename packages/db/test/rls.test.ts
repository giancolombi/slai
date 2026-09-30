import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { ORG_SCOPED_TABLES, organizations, tickets, users } from "../src/schema.js";
import { failure, openDbs, seedOrg } from "./helpers.js";

const { owner, app, system } = openDbs();
let a: Awaited<ReturnType<typeof seedOrg>>;
let b: Awaited<ReturnType<typeof seedOrg>>;

beforeAll(async () => {
  a = await seedOrg(owner, 2);
  b = await seedOrg(owner, 3);
});

describe("row-level security through withOrg", () => {
  it("org A sees only its own tickets", async () => {
    const rows = await app.withOrg(a.orgId, (tx) => tx.select().from(tickets));
    expect(rows.map((r) => r.id).sort()).toEqual([...a.ticketIds].sort());
    expect(rows.every((r) => r.orgId === a.orgId)).toBe(true);
  });

  it("org A cannot read org B's ticket even by id", async () => {
    const rows = await app.withOrg(a.orgId, (tx) => tx.select().from(tickets).where(eq(tickets.id, b.ticketIds[0]!)));
    expect(rows).toEqual([]);
  });

  it("org A cannot update or delete org B's tickets", async () => {
    const updated = await app.withOrg(a.orgId, (tx) =>
      tx.update(tickets).set({ subject: "pwned" }).where(eq(tickets.orgId, b.orgId)).returning(),
    );
    const deleted = await app.withOrg(a.orgId, (tx) =>
      tx.delete(tickets).where(eq(tickets.orgId, b.orgId)).returning(),
    );
    expect(updated).toEqual([]);
    expect(deleted).toEqual([]);
    const still = await app.withOrg(b.orgId, (tx) => tx.select().from(tickets));
    expect(still).toHaveLength(3);
    expect(still.some((t) => t.subject === "pwned")).toBe(false);
  });

  it("org A cannot insert rows into org B", async () => {
    const now = new Date();
    expect(
      await failure(
        app.withOrg(a.orgId, (tx) =>
          tx.insert(tickets).values({
            orgId: b.orgId,
            connectionId: b.connectionId,
            externalId: randomUUID(),
            displayKey: "#x",
            status: "open",
            createdAtSource: now,
            updatedAtSource: now,
          }),
        ),
      ),
    ).toMatch(/row-level security/);
  });

  it("sees no org data at all outside withOrg", async () => {
    expect(await app.db.select().from(tickets)).toEqual([]);
    expect(await app.db.select().from(organizations)).toEqual([]);
  });

  it("the org setting does not leak to the next transaction on the same connection", async () => {
    await app.withOrg(a.orgId, async () => {});
    const rows = await app.db.transaction((tx) => tx.select().from(tickets));
    expect(rows).toEqual([]);
  });

  it("rejects a non-uuid org id", async () => {
    expect(await failure(app.withOrg("' or 1=1 --", async () => {}))).toMatch(/uuid/);
  });
});

describe("the app role cannot bypass RLS", () => {
  it("is not a superuser and has no BYPASSRLS", async () => {
    const [role] = await app.client`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`;
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it("cannot turn row security off", async () => {
    expect(
      await failure(
        app.client.begin(async (tx) => {
          await tx`set local row_security = off`;
          await tx`select * from tickets`;
        }),
      ),
    ).toMatch(/row-level security/);
  });

  it("cannot disable RLS or drop the policy", async () => {
    expect(await failure(app.client`alter table tickets disable row level security`)).toMatch(/owner/);
    expect(await failure(app.client`drop policy org_isolation on tickets`)).toMatch(/owner/);
  });

  it("cannot assume another role", async () => {
    expect(await failure(app.client`set role slai`)).toMatch(/permission denied/);
  });

  it("cannot read password hashes, MFA secrets, or sessions", async () => {
    expect(await failure(app.db.select({ h: users.passwordHash }).from(users))).toMatch(/permission denied/);
    expect(await failure(app.db.select({ s: users.mfaSecret }).from(users))).toMatch(/permission denied/);
    expect(await failure(app.client`select * from sessions`)).toMatch(/permission denied/);
  });

  it("every org-scoped table has forced RLS and the org_isolation policy", async () => {
    const rows = await owner.client<{ relname: string; rls: boolean; forced: boolean; policies: number }[]>`
      select c.relname, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
        (select count(*)::int from pg_policies p where p.tablename = c.relname and p.policyname = 'org_isolation') as policies
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'`;
    const byName = new Map(rows.map((r) => [r.relname, r]));
    for (const t of [...ORG_SCOPED_TABLES, "organizations"]) {
      expect(byName.get(t), t).toMatchObject({ rls: true, forced: true, policies: 1 });
    }
    // And every table with an org_id column is in the list.
    const withOrgId = await owner.client<{ table_name: string }[]>`
      select table_name from information_schema.columns where table_schema = 'public' and column_name = 'org_id'`;
    expect(withOrgId.map((r) => r.table_name).sort()).toEqual([...ORG_SCOPED_TABLES].sort());
  });
});

describe("the system role (systemDb)", () => {
  it("can run the cross-org timer sweep", async () => {
    const due = await system.db
      .select({ id: tickets.id, orgId: tickets.orgId, nextCheckAt: tickets.nextCheckAt })
      .from(tickets)
      .where(sql`${tickets.orgId} in (${a.orgId}, ${b.orgId})`);
    expect(due).toHaveLength(5);
  });

  it("cannot read ticket content or credentials", async () => {
    expect(await failure(system.db.select({ s: tickets.subject }).from(tickets))).toMatch(/permission denied/);
    expect(await failure(system.client`select credentials from connections`)).toMatch(/permission denied/);
    expect(await failure(system.client`select * from sla_policies`)).toMatch(/permission denied/);
  });
});
