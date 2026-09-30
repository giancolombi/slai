import type { Me } from "@slai/shared";
import type { QueryClient } from "@tanstack/react-query";
import { qk } from "../../lib/queries";

/**
 * Where to go after a successful sign-in: the requested page, else the dashboard. A new
 * organization's owners and admins find the getting-started checklist there (and a
 * first-run welcome); invited members and viewers get a role-aware welcome instead.
 */
export async function destinationAfterLogin(queryClient: QueryClient, me: Me, redirect?: string): Promise<string> {
  queryClient.setQueryData(qk.me, me);
  if (redirect?.startsWith("/") && !redirect.startsWith("//")) return redirect;
  return "/";
}
