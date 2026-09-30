import { useMembers } from "./queries";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Audit-style fields (`approvedBy`, `uploadedBy`, `decidedBy`) may carry a user id or a
 * display name. Resolve ids against the org's members; keep names as they are.
 */
export function resolvePerson(value: string | null | undefined, members: { userId: string; name: string }[] = []) {
  if (!value) return null;
  const member = members.find((m) => m.userId === value);
  if (member) return member.name;
  if (value === "autopilot") return "Autopilot";
  return UUID.test(value) ? "A former member" : value;
}

export function usePersonName() {
  const members = useMembers();
  const list = members.data?.items ?? [];
  return (value: string | null | undefined) => resolvePerson(value, list);
}
