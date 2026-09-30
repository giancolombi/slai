import { keepPreviousData, QueryCache, QueryClient, queryOptions, useQuery } from "@tanstack/react-query";
import { api, isApiError, type KnowledgeArticleQuery, type TicketQuery } from "./api";

export const qk = {
  me: ["me"] as const,
  org: ["org"] as const,
  sso: ["org-sso"] as const,
  passkeys: ["passkeys"] as const,
  members: ["members"] as const,
  connectors: ["connectors"] as const,
  connections: ["connections"] as const,
  connection: (id: string) => ["connections", id] as const,
  connectionMapping: (id: string) => ["connections", id, "mapping"] as const,
  customers: ["customers"] as const,
  contracts: ["contracts"] as const,
  contract: (id: string) => ["contracts", id] as const,
  policies: ["policies"] as const,
  policy: (id: string) => ["policies", id] as const,
  tickets: (q: TicketQuery = {}) => ["tickets", q] as const,
  ticket: (id: string) => ["ticket", id] as const,
  actions: (status: string) => ["actions", status] as const,
  autonomy: ["autonomy"] as const,
  channels: ["channels"] as const,
  dashboard: ["dashboard"] as const,
  replays: ["replays"] as const,
  replay: (id: string) => ["replays", id] as const,
  usage: ["usage"] as const,
  audit: ["audit"] as const,
  knowledgeSources: ["knowledge", "sources"] as const,
  knowledgeArticles: (q: KnowledgeArticleQuery = {}) => ["knowledge", "articles", q] as const,
};

export function createQueryClient(
  options: { onUnauthorized?: () => void; onMfaGate?: (to: "/mfa/setup" | "/mfa") => void } = {},
) {
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (error) => {
        if (!isApiError(error)) return;
        if (error.isUnauthorized) options.onUnauthorized?.();
        // The server's MFA gate: a session without its second factor can only use /auth.
        else if (error.isEnrollmentRequired) options.onMfaGate?.("/mfa/setup");
        else if (error.isMfaRequired) options.onMfaGate?.("/mfa");
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        retry: (count, error) => {
          if (isApiError(error) && error.status >= 400 && error.status < 500) return false;
          return count < 2;
        },
      },
      mutations: { retry: false },
    },
  });
}

export const meQuery = queryOptions({ queryKey: qk.me, queryFn: api.auth.me, staleTime: 5 * 60_000 });

export const useMe = () => useQuery(meQuery);
export const useOrg = () => useQuery({ queryKey: qk.org, queryFn: api.org.get });
export const useOrgSso = (enabled = true) => useQuery({ queryKey: qk.sso, queryFn: api.sso.get, enabled });
export const usePasskeys = () => useQuery({ queryKey: qk.passkeys, queryFn: api.passkeys.list });
export const useMembers = () => useQuery({ queryKey: qk.members, queryFn: api.members.list });
export const useConnectors = () =>
  useQuery({ queryKey: qk.connectors, queryFn: api.connectors.list, staleTime: 10 * 60_000 });
export const useConnections = () => useQuery({ queryKey: qk.connections, queryFn: api.connections.list });
export const useConnection = (id: string) =>
  useQuery({ queryKey: qk.connection(id), queryFn: () => api.connections.get(id) });
export const useConnectionMapping = (id: string) =>
  useQuery({ queryKey: qk.connectionMapping(id), queryFn: () => api.connections.mapping(id) });
export const useCustomers = () => useQuery({ queryKey: qk.customers, queryFn: api.customers.list });
export const useContracts = (poll = false) =>
  useQuery({
    queryKey: qk.contracts,
    queryFn: api.contracts.list,
    refetchInterval: (q) =>
      poll || q.state.data?.items.some((c) => c.status === "extracting" || c.status === "uploaded") ? 2_500 : false,
  });
export const useContract = (id: string) =>
  useQuery({
    queryKey: qk.contract(id),
    queryFn: () => api.contracts.get(id),
    refetchInterval: (q) =>
      q.state.data?.status === "extracting" || q.state.data?.status === "uploaded" ? 2_000 : false,
  });
export const usePolicies = () => useQuery({ queryKey: qk.policies, queryFn: api.policies.list });
export const usePolicy = (id: string | null | undefined) =>
  useQuery({ queryKey: qk.policy(id ?? ""), queryFn: () => api.policies.get(id!), enabled: Boolean(id) });
export const useTickets = (q: TicketQuery) =>
  useQuery({
    queryKey: qk.tickets(q),
    queryFn: ({ signal }) => api.tickets.list(q, signal),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });
export const useTicket = (id: string) =>
  useQuery({ queryKey: qk.ticket(id), queryFn: () => api.tickets.get(id), refetchInterval: 30_000 });
export const useActions = (status: "proposed" | "sent" | "rejected" | "blocked" = "proposed") =>
  useQuery({ queryKey: qk.actions(status), queryFn: () => api.actions.list(status), refetchInterval: 30_000 });
export const useAutonomy = () => useQuery({ queryKey: qk.autonomy, queryFn: api.autonomy.list });
export const useChannels = () => useQuery({ queryKey: qk.channels, queryFn: api.notifications.list });
export const useDashboard = () =>
  useQuery({ queryKey: qk.dashboard, queryFn: api.dashboard.get, refetchInterval: 30_000 });
export const useReplays = () =>
  useQuery({
    queryKey: qk.replays,
    queryFn: api.replays.list,
    refetchInterval: (q) =>
      q.state.data?.items.some((r) => r.status === "queued" || r.status === "running") ? 1_500 : false,
  });
export const useReplay = (id: string) =>
  useQuery({
    queryKey: qk.replay(id),
    queryFn: () => api.replays.get(id),
    refetchInterval: (q) => (q.state.data?.status === "queued" || q.state.data?.status === "running" ? 1_000 : false),
  });
export const useKnowledgeSources = () =>
  useQuery({
    queryKey: qk.knowledgeSources,
    queryFn: api.knowledge.sources,
    refetchInterval: (q) => (q.state.data?.items.some((s) => s.status === "syncing") ? 2_000 : false),
  });
export const useKnowledgeArticles = (q: KnowledgeArticleQuery, enabled = true) =>
  useQuery({
    queryKey: qk.knowledgeArticles(q),
    queryFn: ({ signal }) => api.knowledge.articles(q, signal),
    placeholderData: keepPreviousData,
    enabled,
  });
export const useUsage = () => useQuery({ queryKey: qk.usage, queryFn: api.usage.get });
