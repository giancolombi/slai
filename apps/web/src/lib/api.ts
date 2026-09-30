/**
 * Typed client for the slai HTTP API (`@slai/shared` is the contract).
 *
 * - Base `/api/v1`, cookies included (`slai_session` is httpOnly).
 * - Every state-changing request sends `X-Requested-With: slai` (CSRF defense).
 * - Non-2xx responses throw `ApiError` with the server's `{ error: { code, message, details } }`;
 *   network failures throw `ApiError` with status 0 and code `network_error`.
 */

import type {
  approveActionBody,
  autonomyRuleBody,
  billingCheckoutBody,
  createConnectionBody,
  createKnowledgeSourceBody,
  createPolicyBody,
  createReplayBody,
  createSsoProviderBody,
  creditPackCheckoutBody,
  inviteBody,
  loginBody,
  manualBillingBody,
  notificationChannelBody,
  policyPreviewBody,
  rejectActionBody,
  savedReplyBody,
  signupBody,
  switchOrgBody,
  updateMemberBody,
  updateOrgBody,
  updateOrgSsoBody,
  updatePolicyBody,
  updateSavedReplyBody,
  updateSsoProviderBody,
  upsertCustomerBody,
} from "@slai/shared";
import {
  type AgentAction,
  type AgentRun,
  API_BASE,
  type ApiError as ApiErrorBody,
  type AuditEvent,
  type AutonomyRule,
  type BackupCodes,
  type BillingRedirect,
  type BillingSummary,
  type Connection,
  type ConnectorInfo,
  type Contract,
  type CustomerAccount,
  type DashboardSummary,
  type KnowledgeArticle,
  type KnowledgeSource,
  type List,
  type Me,
  type Member,
  type NotificationChannel,
  type OrgSettings,
  type OrgSsoSettings,
  type Passkey,
  type Policy,
  type PolicyPreview,
  type Replay,
  type Risk,
  type Role,
  type SignInDiscovery,
  type SignInResult,
  type SsoProvider,
  type TicketDetail,
  type TicketStatus,
  type TicketSummary,
  type TotpEnrollment,
  type UsageSummary,
} from "@slai/shared";
import type { z } from "zod";

export const CSRF_HEADER = "X-Requested-With";
export const CSRF_VALUE = "slai";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  get isUnauthorized() {
    return this.status === 401;
  }
  /** A session exists, but its second factor is not verified yet. */
  get isMfaRequired() {
    return this.code === "mfa_required";
  }
  /** A session exists, but the user has no second factor yet (mandatory enrollment). */
  get isEnrollmentRequired() {
    return this.code === "mfa_enrollment_required";
  }
  get isForbidden() {
    return this.status === 403;
  }
  get isNotFound() {
    return this.status === 404;
  }
  get isValidation() {
    return this.status === 400 || this.status === 422;
  }
  get isNetwork() {
    return this.status === 0;
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type Query = Record<string, string | number | boolean | null | undefined>;

export interface RequestOptions {
  body?: unknown;
  query?: Query;
  signal?: AbortSignal;
}

const DEFAULT_MESSAGES: Record<number, string> = {
  400: "The request was not valid.",
  401: "Please sign in again.",
  403: "You don't have permission to do that.",
  404: "Not found.",
  409: "That conflicts with a recent change. Refresh and try again.",
  429: "Too many requests. Try again in a moment.",
};

function buildUrl(path: string, query?: Query) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  }
  const s = qs.toString();
  return `${API_BASE}${path}${s ? `?${s}` : ""}`;
}

export function isMutation(method: string) {
  return method !== "GET" && method !== "HEAD";
}

/** Turns a failed Response into an ApiError, tolerating non-JSON bodies. */
export async function toApiError(res: Response): Promise<ApiError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* not JSON */
  }
  const err = (body as ApiErrorBody | null)?.error;
  if (err && typeof err.code === "string") {
    return new ApiError(
      res.status,
      err.code,
      err.message || DEFAULT_MESSAGES[res.status] || "Request failed.",
      err.details,
    );
  }
  return new ApiError(
    res.status,
    `http_${res.status}`,
    DEFAULT_MESSAGES[res.status] ?? (res.status >= 500 ? "Something went wrong on our side." : "Request failed."),
  );
}

export async function request<T>(method: Method, path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (isMutation(method)) headers[CSRF_HEADER] = CSRF_VALUE;
  let body: BodyInit | undefined;
  if (options.body instanceof FormData) {
    body = options.body;
  } else if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }

  let res: Response;
  try {
    res = await fetch(buildUrl(path, options.query), {
      method,
      headers,
      body,
      credentials: "include",
      signal: options.signal,
    });
  } catch (e) {
    if ((e as Error)?.name === "AbortError") throw e;
    throw new ApiError(0, "network_error", "Can't reach slai. Check your connection and try again.");
  }

  if (!res.ok) throw await toApiError(res);
  if (res.status === 204 || res.status === 202) {
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("json")) return (await res.text()) as T;
  return (await res.json()) as T;
}

/**
 * Multipart upload with progress (fetch has no upload progress events, so this uses XHR
 * with the same credentials, CSRF header and error typing).
 */
export function upload<T>(path: string, form: FormData, onProgress?: (fraction: number) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", buildUrl(path));
    xhr.withCredentials = true;
    xhr.setRequestHeader(CSRF_HEADER, CSRF_VALUE);
    xhr.setRequestHeader("Accept", "application/json");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onerror = () => reject(new ApiError(0, "network_error", "Upload failed. Check your connection and try again."));
    xhr.onload = () => {
      const res = new Response(xhr.status === 204 ? null : xhr.responseText, {
        status: xhr.status,
        headers: { "content-type": xhr.getResponseHeader("content-type") ?? "application/json" },
      });
      if (!res.ok) {
        toApiError(res).then(reject, reject);
        return;
      }
      onProgress?.(1);
      res.json().then((v) => resolve(v as T), reject);
    };
    xhr.send(form);
  });
}

const get = <T>(path: string, query?: Query, signal?: AbortSignal) => request<T>("GET", path, { query, signal });
const post = <T>(path: string, body?: unknown) => request<T>("POST", path, { body });
const patch = <T>(path: string, body?: unknown) => request<T>("PATCH", path, { body });
const put = <T>(path: string, body?: unknown) => request<T>("PUT", path, { body });
const del = <T = void>(path: string) => request<T>("DELETE", path);

type In<S extends z.ZodType> = z.input<S>;
const id = encodeURIComponent;

/** `POST /members/invite` response. The contract doesn't name it; the API returns the pending invitation. */
export interface Invitation {
  id?: string;
  email: string;
  role: Role;
  expiresAt?: string;
}

export interface TicketQuery {
  risk?: Risk | "";
  status?: TicketStatus | "";
  customerId?: string;
  q?: string;
  cursor?: string | null;
}

export interface KnowledgeArticleQuery {
  q?: string;
  sourceId?: string;
  cursor?: string | null;
  limit?: number;
}

export const api = {
  auth: {
    me: () => get<Me>("/auth/me"),
    discover: (email: string) => post<SignInDiscovery>("/auth/discover", { email }),
    signIn: (body: In<typeof loginBody>) => post<SignInResult>("/auth/sign-in/email", body),
    signup: (body: In<typeof signupBody>) => post<SignInResult>("/auth/signup", body),
    /** Starts SSO; the browser then navigates to the returned IdP URL. */
    ssoStart: (body: { email?: string; providerId?: string; redirect?: string }) =>
      post<{ url: string }>("/auth/sign-in/sso", body),
    verifyTotp: (code: string) => post<SignInResult>("/auth/two-factor/verify-totp", { code }),
    verifyBackupCode: (code: string) => post<SignInResult>("/auth/two-factor/verify-backup-code", { code }),
    logout: () => post<void>("/auth/logout"),
    switchOrg: (organizationId: string) =>
      post<Me>("/auth/switch-org", { organizationId } satisfies In<typeof switchOrgBody>),
  },
  totp: {
    enable: (password?: string) => post<TotpEnrollment>("/auth/two-factor/enable", { password }),
    regenerateBackupCodes: (password?: string) =>
      post<BackupCodes>("/auth/two-factor/generate-backup-codes", { password }),
    disable: (password?: string) => post<void>("/auth/two-factor/disable", { password }),
  },
  passkeys: {
    registerOptions: () => get<unknown>("/auth/passkey/generate-register-options"),
    register: (response: unknown, name?: string) =>
      post<Passkey>("/auth/passkey/verify-registration", { response, name }),
    authenticateOptions: () => get<unknown>("/auth/passkey/generate-authenticate-options"),
    authenticate: (response: unknown) => post<SignInResult>("/auth/passkey/verify-authentication", { response }),
    list: () => get<Passkey[]>("/auth/passkey/list-user-passkeys"),
    remove: (passkeyId: string) => post<void>("/auth/passkey/delete-passkey", { id: passkeyId }),
  },
  org: {
    get: () => get<OrgSettings>("/org"),
    update: (body: In<typeof updateOrgBody>) => patch<OrgSettings>("/org", body),
  },
  sso: {
    get: () => get<OrgSsoSettings>("/org/sso"),
    update: (body: In<typeof updateOrgSsoBody>) => patch<OrgSsoSettings>("/org/sso", body),
    create: (body: In<typeof createSsoProviderBody>) => post<SsoProvider>("/org/sso/providers", body),
    updateProvider: (providerId: string, body: In<typeof updateSsoProviderBody>) =>
      patch<SsoProvider>(`/org/sso/providers/${id(providerId)}`, body),
    remove: (providerId: string) => del(`/org/sso/providers/${id(providerId)}`),
    verifyDomain: (providerId: string) => post<SsoProvider>(`/org/sso/providers/${id(providerId)}/verify-domain`),
  },
  members: {
    list: () => get<List<Member>>("/members"),
    invite: (body: In<typeof inviteBody>) => post<Invitation>("/members/invite", body),
    setRole: (userId: string, role: Role) =>
      patch<Member>(`/members/${id(userId)}`, { role } satisfies In<typeof updateMemberBody>),
    remove: (userId: string) => del(`/members/${id(userId)}`),
  },
  connectors: {
    list: () => get<ConnectorInfo[]>("/connectors"),
  },
  connections: {
    list: () => get<List<Connection>>("/connections"),
    get: (connectionId: string) => get<Connection>(`/connections/${id(connectionId)}`),
    create: (body: In<typeof createConnectionBody>) => post<Connection>("/connections", body),
    remove: (connectionId: string) => del(`/connections/${id(connectionId)}`),
    test: (connectionId: string) => post<{ ok: boolean; accountName: string }>(`/connections/${id(connectionId)}/test`),
    sync: (connectionId: string) => post<void>(`/connections/${id(connectionId)}/sync`),
  },
  customers: {
    list: () => get<List<CustomerAccount>>("/customers"),
    create: (body: In<typeof upsertCustomerBody>) => post<CustomerAccount>("/customers", body),
    update: (customerId: string, body: Partial<In<typeof upsertCustomerBody>>) =>
      patch<CustomerAccount>(`/customers/${id(customerId)}`, body),
    remove: (customerId: string) => del(`/customers/${id(customerId)}`),
  },
  contracts: {
    list: () => get<List<Contract>>("/contracts"),
    get: (contractId: string) => get<Contract>(`/contracts/${id(contractId)}`),
    upload: (file: File, customerAccountId: string | null, onProgress?: (fraction: number) => void) => {
      const form = new FormData();
      form.set("file", file);
      if (customerAccountId) form.set("customerAccountId", customerAccountId);
      return upload<Contract>("/contracts", form, onProgress);
    },
    extract: (contractId: string) => post<void>(`/contracts/${id(contractId)}/extract`),
    fileUrl: (contractId: string) => `${API_BASE}/contracts/${id(contractId)}/file`,
  },
  policies: {
    list: () => get<List<Policy>>("/policies"),
    get: (policyId: string) => get<Policy>(`/policies/${id(policyId)}`),
    create: (body: In<typeof createPolicyBody>) => post<Policy>("/policies", body),
    update: (policyId: string, body: In<typeof updatePolicyBody>) => patch<Policy>(`/policies/${id(policyId)}`, body),
    approve: (policyId: string) => post<Policy>(`/policies/${id(policyId)}/approve`),
    archive: (policyId: string) => post<Policy>(`/policies/${id(policyId)}/archive`),
    preview: (policyId: string, body: In<typeof policyPreviewBody>) =>
      post<PolicyPreview>(`/policies/${id(policyId)}/preview`, body),
  },
  tickets: {
    list: (query: TicketQuery = {}, signal?: AbortSignal) =>
      get<List<TicketSummary>>("/tickets", query as Query, signal),
    get: (ticketId: string) => get<TicketDetail>(`/tickets/${id(ticketId)}`),
    runAgent: (ticketId: string, kind: "triage" | "draft_reply") =>
      post<AgentRun>(`/tickets/${id(ticketId)}/agents/${kind}`),
  },
  actions: {
    list: (status: AgentAction["status"] = "proposed") => get<List<AgentAction>>("/actions", { status }),
    approve: (actionId: string, body: In<typeof approveActionBody> = {}) =>
      post<AgentAction>(`/actions/${id(actionId)}/approve`, body),
    reject: (actionId: string, body: In<typeof rejectActionBody> = {}) =>
      post<AgentAction>(`/actions/${id(actionId)}/reject`, body),
  },
  autonomy: {
    list: () => get<AutonomyRule[]>("/autonomy-rules"),
    create: (body: In<typeof autonomyRuleBody>) => post<AutonomyRule>("/autonomy-rules", body),
    update: (ruleId: string, body: In<typeof autonomyRuleBody>) =>
      put<AutonomyRule>(`/autonomy-rules/${id(ruleId)}`, body),
    remove: (ruleId: string) => del(`/autonomy-rules/${id(ruleId)}`),
  },
  knowledge: {
    sources: () => get<List<KnowledgeSource>>("/knowledge-sources"),
    createSource: (body: In<typeof createKnowledgeSourceBody>) => post<KnowledgeSource>("/knowledge-sources", body),
    syncSource: (sourceId: string) => post<{ queued: boolean }>(`/knowledge-sources/${id(sourceId)}/sync`),
    articles: (query: KnowledgeArticleQuery = {}, signal?: AbortSignal) =>
      get<List<KnowledgeArticle>>("/knowledge-articles", query as Query, signal),
    setEnabled: (articleId: string, enabled: boolean) =>
      patch<KnowledgeArticle>(`/knowledge-articles/${id(articleId)}`, { enabled }),
    createReply: (body: In<typeof savedReplyBody>) => post<KnowledgeArticle>("/saved-replies", body),
    updateReply: (articleId: string, body: In<typeof updateSavedReplyBody>) =>
      patch<KnowledgeArticle>(`/saved-replies/${id(articleId)}`, body),
    removeReply: (articleId: string) => del(`/saved-replies/${id(articleId)}`),
  },
  notifications: {
    list: () => get<NotificationChannel[]>("/notification-channels"),
    create: (body: In<typeof notificationChannelBody>) => post<NotificationChannel>("/notification-channels", body),
    update: (channelId: string, body: Partial<In<typeof notificationChannelBody>>) =>
      patch<NotificationChannel>(`/notification-channels/${id(channelId)}`, body),
    remove: (channelId: string) => del(`/notification-channels/${id(channelId)}`),
  },
  dashboard: {
    get: () => get<DashboardSummary>("/dashboard"),
  },
  replays: {
    list: () => get<List<Replay>>("/replays"),
    get: (replayId: string) => get<Replay>(`/replays/${id(replayId)}`),
    create: (body: In<typeof createReplayBody>) => post<Replay>("/replays", body),
  },
  usage: {
    get: () => get<UsageSummary>("/usage"),
  },
  billing: {
    get: () => get<BillingSummary>("/billing"),
    checkout: (body: In<typeof billingCheckoutBody>) => post<BillingRedirect>("/billing/checkout", body),
    portal: () => post<BillingRedirect>("/billing/portal"),
    creditPackCheckout: (body: In<typeof creditPackCheckoutBody>) =>
      post<BillingRedirect>("/billing/credit-packs/checkout", body),
    manual: (body: In<typeof manualBillingBody>) => post<BillingSummary>("/billing/manual", body),
  },
  audit: {
    list: (cursor?: string | null) => get<List<AuditEvent>>("/audit-events", { cursor }),
  },
};

/** A human message for any thrown value. */
export function errorMessage(e: unknown): string {
  if (isApiError(e)) return e.message;
  if (e instanceof Error) return e.message;
  return "Something went wrong.";
}
