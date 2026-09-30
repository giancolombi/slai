/**
 * Failure reasons the worker stores (agent_runs.error, contracts.error, connections.last_error,
 * knowledge_sources.last_error) are raw: provider bodies, HTTP lines, zod issues, stack-ish text.
 * They stay raw in the database and the logs; this turns them into a sentence a support leader
 * can act on before they leave the API.
 */
export type ErrorKind = "agent_run" | "contract" | "connection" | "knowledge_source";

/** Sentences slai itself writes: already user-facing, passed through unchanged. */
const OWN_SENTENCES = [
  /^The connection no longer exists\.$/,
  /^The export failed\. Try again, or contact support\.$/,
  /^.{1,60} does not provide (saved replies|help-center articles) to slai yet\.$/,
];

const HELP_DESK = {
  auth: "The help desk rejected slai's credentials. Reconnect it with a new API token (or sign in again).",
  notFound:
    "The help desk couldn't find the account or item slai asked for. Check the help desk address and reconnect.",
  rateLimited: "The help desk is limiting requests right now. slai will retry automatically.",
  unreachable: "slai couldn't reach the help desk. Check its address; slai will keep retrying.",
  upstream: "The help desk had a problem on its side. slai will retry automatically.",
  invalid: "The help desk refused the request. Check the connection's settings and field mapping.",
  unsupported: "This help desk doesn't support that yet.",
};

/** Maps a connector-style failure (HTTP line, network error) to a help-desk sentence, or null. */
function helpDeskReason(raw: string): string | null {
  if (
    /→ 40[13]\b|\b40[13]\b.*(unauthori[sz]ed|forbidden)|not authenticated|invalid[_ ](grant|token|credentials)|unauthori[sz]ed|refresh token|oauth/i.test(
      raw,
    )
  )
    return HELP_DESK.auth;
  if (/→ 429\b|rate.?limit|too many requests/i.test(raw)) return HELP_DESK.rateLimited;
  if (/→ 404\b|not found/i.test(raw)) return HELP_DESK.notFound;
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ETIMEDOUT|timed out|fetch failed|aborted|getaddrinfo/i.test(raw))
    return HELP_DESK.unreachable;
  if (/→ 5\d\d\b|non-JSON|malformed pagination|unexpected host/i.test(raw)) return HELP_DESK.upstream;
  if (/→ (400|409|422)\b|is mapped to|no .* maps to|invalid config/i.test(raw)) return HELP_DESK.invalid;
  if (/have no tags|not supported|unsupported/i.test(raw)) return HELP_DESK.unsupported;
  return null;
}

/** Agent-level skips and failures (the worker's `decide` reasons and runner error kinds). */
function agentReason(raw: string): string {
  if (/^autonomy is observe/i.test(raw)) return "Skipped: autonomy for this ticket is set to Observe (alerts only).";
  if (/spend cap reached/i.test(raw))
    return "Skipped: this month's AI spend cap is reached, so agents only watch. Raise the cap on Billing to resume.";
  if (/plan allows observe only/i.test(raw))
    return "Skipped: your current plan allows alerts only. Upgrade on Billing.";
  if (/plan allows triage only/i.test(raw)) return "Skipped: your current plan allows triage only. Upgrade on Billing.";
  const upTo = /plan allows up to (assist|autopilot)/i.exec(raw);
  if (upTo)
    return `Limited by your plan: agents may go up to ${upTo[1] === "assist" ? "Assist" : "Autopilot"}. Upgrade on Billing.`;
  if (/^bound_exceeded/i.test(raw))
    return "The agent reached its time or credit limit for one run and stopped. Nothing was posted.";
  if (/^invalid_output/i.test(raw))
    return "The agent's answer didn't pass slai's checks, so it wasn't used. Nothing was posted.";
  if (/^sandbox_error/i.test(raw)) return "The agent couldn't start. Nothing was posted. Try again in a moment.";
  if (/^provider_error/i.test(raw))
    return "The AI service didn't respond in time. Nothing was posted. Try again in a moment.";
  const hd = helpDeskReason(raw);
  if (hd) return hd;
  return "The agent couldn't finish this run. Nothing was posted.";
}

function contractReason(raw: string): string {
  if (/^unsupported file type/i.test(raw))
    return "slai can't read this file type. Upload a PDF, DOCX, TXT or Markdown file.";
  if (/^extracted policy is invalid/i.test(raw))
    return "slai read the contract but couldn't turn it into a valid policy. Create the policy by hand, or upload a clearer copy.";
  if (/^bound_exceeded/i.test(raw))
    return "This contract is too long to read in one pass. Upload just the SLA schedule, or create the policy by hand.";
  if (/^invalid_output/i.test(raw))
    return "slai couldn't read reliable SLA terms from this contract. Try again, or create the policy by hand.";
  return "slai couldn't read this contract. Try again in a moment; if it keeps failing, create the policy by hand.";
}

/** The user-facing sentence for a stored failure reason (null stays null). */
export function userFacingError(kind: ErrorKind, raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw.trim() === "") return null;
  if (OWN_SENTENCES.some((re) => re.test(raw)) || Object.values(HELP_DESK).includes(raw)) return raw;
  switch (kind) {
    case "agent_run":
      return agentReason(raw);
    case "contract":
      return contractReason(raw);
    case "connection":
      return (
        helpDeskReason(raw) ??
        "slai couldn't sync with the help desk. Test the connection, and reconnect if it keeps failing."
      );
    case "knowledge_source":
      return helpDeskReason(raw) ?? "slai couldn't sync this knowledge source. It will try again on the next sync.";
  }
}

/** A connector failure by kind (when the error object is at hand, e.g. testing a connection). */
export function helpDeskErrorByKind(
  kind: "auth" | "rate_limited" | "not_found" | "invalid" | "upstream" | "unsupported" | string,
): string {
  switch (kind) {
    case "auth":
      return HELP_DESK.auth;
    case "rate_limited":
      return HELP_DESK.rateLimited;
    case "not_found":
      return HELP_DESK.notFound;
    case "invalid":
      return HELP_DESK.invalid;
    case "unsupported":
      return HELP_DESK.unsupported;
    default:
      return HELP_DESK.upstream;
  }
}
