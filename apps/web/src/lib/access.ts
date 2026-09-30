import type { Role } from "@slai/shared";
import { useMe } from "./queries";

export interface Access {
  role: Role | undefined;
  /** Owners and admins: settings, connections, autonomy, knowledge sources, alerts, the audit log. */
  isAdmin: boolean;
  isOwner: boolean;
  /** Everyone but viewers: run agents, approve and reject drafts, edit customers. */
  canWork: boolean;
}

export function accessFor(role: Role | undefined): Access {
  return {
    role,
    isAdmin: role === "owner" || role === "admin",
    isOwner: role === "owner",
    canWork: role !== undefined && role !== "viewer",
  };
}

/** What the signed-in user's role lets them do, so pages hide controls they can't use. */
export function useAccess(): Access {
  const { data: me } = useMe();
  return accessFor(me?.role);
}
