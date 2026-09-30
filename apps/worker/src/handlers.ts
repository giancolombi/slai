import { ConnectorError } from "@slai/connectors";
import { JOB_NAMES, type JOB_PAYLOADS, type JobName, parseJob } from "@slai/db";
import type { z } from "zod";
import { executeAction, runAgent } from "./agents.js";
import { billingSnapshotJob } from "./billing.js";
import type { WorkerDeps } from "./deps.js";
import { extractContractJob } from "./extract.js";
import { syncKnowledge } from "./knowledge.js";
import { deleteOrgIfDue, exportOrg } from "./offboarding.js";
import { runReplay } from "./replay.js";
import { runRetention } from "./retention.js";
import { evaluateTicketJob, ingestTicket, processWebhook, remapConnection, syncConnection } from "./sync.js";

type Data<N extends JobName> = z.output<(typeof JOB_PAYLOADS)[N]>;
export type Handlers = { [N in JobName]: (payload: Data<N>) => Promise<void> };

export function createHandlers(deps: WorkerDeps): Handlers {
  return {
    "sync-connection": (p) => syncConnection(deps, p),
    "process-webhook": (p) => processWebhook(deps, p),
    "ingest-ticket": (p) => ingestTicket(deps, p),
    "remap-connection": (p) => remapConnection(deps, p),
    "evaluate-ticket": (p) => evaluateTicketJob(deps, p),
    "run-agent": (p) => runAgent(deps, p),
    "execute-action": (p) => executeAction(deps, p),
    "extract-contract": (p) => extractContractJob(deps, p),
    "run-replay": (p) => runReplay(deps, p),
    "run-retention": async () => {
      await runRetention(deps);
    },
    "export-org": (p) => exportOrg(deps, p),
    "delete-org": async (p) => {
      await deleteOrgIfDue(deps, p.orgId);
    },
    "sync-knowledge": (p) => syncKnowledge(deps, p),
    "billing-snapshot": (p) => billingSnapshotJob(deps, p),
  };
}

const DEFAULT_RETRY_AFTER_MS = 60_000;

/**
 * Runs one job: validates the payload (trust boundary), and turns a help-desk
 * rate limit into a delayed retry of the same job instead of a failure.
 */
export async function handleJob<N extends JobName>(
  deps: WorkerDeps,
  handlers: Handlers,
  name: N,
  data: unknown,
): Promise<void> {
  const payload = parseJob(name, data);
  try {
    await handlers[name](payload);
  } catch (e) {
    if (e instanceof ConnectorError && e.kind === "rate_limited") {
      const delay = e.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS;
      deps.logger.warn({ job: name, delayMs: delay }, "rate limited; retrying later");
      await deps.queue.send(name, payload as never, { startAfter: new Date(deps.clock.now().getTime() + delay) });
      return;
    }
    throw e;
  }
}

export { JOB_NAMES };
