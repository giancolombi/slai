/**
 * SCIM group → role mapping (T-18). Once an org maps at least one IdP group to a
 * role, the IdP is the source of truth for the roles of SCIM-managed members:
 * each gets the highest role among its mapped groups, or `member` with none.
 * Owners are never changed (owners are managed in slai), and orgs without any
 * mapping keep the roles set in slai.
 */
import { type AuditEntry, audit, memberships, scimGroupMembers, scimGroupRoles, scimGroups, type Tx } from "@slai/db";
import type { Role } from "@slai/shared";
import { and, eq, inArray, ne } from "drizzle-orm";
import { ROLE_RANK } from "../context.js";

/** Recomputes roles (inside withOrg) for the given memberships, or all SCIM-managed ones. */
export async function recomputeRoles(
  tx: Tx,
  orgId: string,
  base: Pick<AuditEntry, "actor" | "ip" | "userAgent" | "requestId">,
  membershipIds?: string[],
): Promise<void> {
  if (membershipIds?.length === 0) return;
  const mappings = await tx.select().from(scimGroupRoles);
  if (mappings.length === 0) return;
  const roleOf = new Map(mappings.map((m) => [m.groupName.toLowerCase(), m.role as Role]));
  const members = await tx
    .select({ id: memberships.id, userId: memberships.userId, role: memberships.role })
    .from(memberships)
    .where(
      and(
        eq(memberships.scimManaged, true),
        ne(memberships.role, "owner"),
        membershipIds ? inArray(memberships.id, membershipIds) : undefined,
      ),
    );
  if (members.length === 0) return;
  const groups = await tx
    .select({ membershipId: scimGroupMembers.membershipId, name: scimGroups.displayName })
    .from(scimGroupMembers)
    .innerJoin(scimGroups, eq(scimGroups.id, scimGroupMembers.groupId))
    .where(
      inArray(
        scimGroupMembers.membershipId,
        members.map((m) => m.id),
      ),
    );
  for (const m of members) {
    const names = groups.filter((g) => g.membershipId === m.id).map((g) => g.name);
    const granted = names.map((n) => roleOf.get(n.toLowerCase())).filter((r): r is Role => r !== undefined);
    const target =
      granted.length === 0 ? "member" : granted.reduce((best, r) => (ROLE_RANK[r] > ROLE_RANK[best] ? r : best));
    if (target === m.role) continue;
    await tx.update(memberships).set({ role: target }).where(eq(memberships.id, m.id));
    await audit(tx, {
      ...base,
      orgId,
      action: "member.role_changed",
      target: { type: "user", id: m.userId },
      metadata: { from: m.role, to: target, source: "scim", groups: names },
    });
  }
}
