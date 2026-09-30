import type { Me } from "@slai/shared";
import type { QueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { qk } from "../../lib/queries";

/**
 * Where to go after a successful sign-in: the requested page, or onboarding for an
 * organization that has not connected a help desk yet, or the dashboard.
 */
export async function destinationAfterLogin(queryClient: QueryClient, me: Me, redirect?: string): Promise<string> {
  queryClient.setQueryData(qk.me, me);
  if (redirect?.startsWith("/") && !redirect.startsWith("//")) return redirect;
  try {
    const connections = await api.connections.list();
    if (connections.items.length === 0) return "/onboarding";
  } catch {
    /* fall through to the dashboard */
  }
  return "/";
}
