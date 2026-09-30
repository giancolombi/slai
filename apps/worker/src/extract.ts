/**
 * The `extract-contract` job (T-44): contract file → draft policies with
 * citations and ambiguities for human review. Nothing extracted becomes active
 * until an admin approves it in the API.
 */
import type { ContractDocument } from "@slai/agents";
import { agentRuns, audit, contracts, customerAccounts, notifyEvent, slaPolicies } from "@slai/db";
import { parsePolicy } from "@slai/sla-engine";
import { and, eq, isNull } from "drizzle-orm";
import type { WorkerDeps } from "./deps.js";
import { errorMessage } from "./logger.js";
import { meterRun, reachedCapThresholds } from "./metering.js";
import { notifyCapThresholds } from "./spend.js";

const MEDIA_TYPES = new Set<ContractDocument["mediaType"]>([
  "application/pdf",
  "text/plain",
  "text/markdown",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

export async function extractContractJob(deps: WorkerDeps, p: { orgId: string; contractId: string }): Promise<void> {
  const { orgId, contractId } = p;
  const now = deps.clock.now();
  const prep = await deps.orgDb.withOrg(orgId, async (tx) => {
    const [c] = await tx.select().from(contracts).where(eq(contracts.id, contractId)).for("update");
    if (!c || (c.status !== "uploaded" && c.status !== "extracting" && c.status !== "failed")) return null;
    await tx.update(contracts).set({ status: "extracting", error: null }).where(eq(contracts.id, contractId));
    const [run] = await tx
      .insert(agentRuns)
      .values({ orgId, kind: "contract_extraction", status: "running", contractId, createdAt: now, startedAt: now })
      .returning({ id: agentRuns.id });
    await notifyEvent(tx, { orgId, type: "contract.updated", id: contractId });
    return { contract: c, runId: run!.id };
  });
  if (!prep) return;
  const { contract, runId } = prep;

  const fail = async (message: string) => {
    await deps.orgDb.withOrg(orgId, async (tx) => {
      await tx.update(contracts).set({ status: "failed", error: message }).where(eq(contracts.id, contractId));
      await tx
        .update(agentRuns)
        .set({ status: "failed", error: message, finishedAt: deps.clock.now() })
        .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, "running")));
      await notifyEvent(tx, { orgId, type: "contract.updated", id: contractId });
    });
  };

  if (!MEDIA_TYPES.has(contract.mediaType as ContractDocument["mediaType"])) {
    await fail(`unsupported file type ${contract.mediaType}`);
    return;
  }
  let result: Awaited<ReturnType<WorkerDeps["agents"]["extractContract"]>>;
  try {
    const bytes = await deps.storage.get(contract.storageKey);
    result = await deps.agents.extractContract([
      {
        filename: contract.filename,
        mediaType: contract.mediaType as ContractDocument["mediaType"],
        base64: Buffer.from(bytes).toString("base64"),
      },
    ]);
  } catch (e) {
    await fail(`extraction failed: ${errorMessage(e)}`);
    return;
  }

  const thresholds = await deps.orgDb.withOrg(orgId, async (tx) => {
    const done = deps.clock.now();
    const u = result.metering.usage;
    const sum = (k: "inputTokens" | "outputTokens" | "costMicros") => u.reduce((s, x) => s + x[k], 0);
    await meterRun(tx, orgId, done, result.metering, 0, { contractId, agentRunId: runId });

    let error: string | null = result.ok ? null : `${result.error}: ${result.message}`.slice(0, 1000);
    const policyIds: string[] = [];
    if (result.ok) {
      const x = result.output;
      let drafts: { id: string; definition: ReturnType<typeof parsePolicy> }[] = [];
      try {
        // Validate every policy before writing any: a draft must be something the engine accepts.
        drafts = x.policies.map((input) => {
          const id = crypto.randomUUID();
          return { id, definition: parsePolicy({ ...input, id }) };
        });
      } catch (e) {
        error = `extracted policy is invalid: ${errorMessage(e)}`;
      }
      if (!error) {
        for (const d of drafts) {
          await tx.insert(slaPolicies).values({
            id: d.id,
            orgId,
            lineageId: d.id,
            name: d.definition.name,
            version: 1,
            status: "draft",
            definition: d.definition,
            contractId,
            createdBy: contract.uploadedBy,
            createdAt: done,
          });
          policyIds.push(d.id);
        }
      }
      if (!error) {
        await tx
          .update(contracts)
          .set({
            status: "needs_review",
            error: null,
            extraction: {
              summary: x.summary,
              citations: x.citations,
              ambiguities: x.ambiguities,
              parties: x.parties,
              policyIds,
            },
          })
          .where(eq(contracts.id, contractId));
        const fee = x.parties.monthlyFeeCents;
        if (fee !== null && Number.isInteger(fee) && fee >= 0 && contract.customerAccountId) {
          await tx
            .update(customerAccounts)
            .set({ monthlyFeeCents: fee })
            .where(and(eq(customerAccounts.id, contract.customerAccountId), isNull(customerAccounts.monthlyFeeCents)));
        }
        await audit(tx, {
          orgId,
          actor: { type: "agent", id: runId, name: "slai extraction" },
          action: "contract.extracted",
          target: { type: "contract", id: contractId },
          metadata: { policyIds, ambiguities: x.ambiguities.length, citations: x.citations.length },
        });
      }
    }
    await tx
      .update(agentRuns)
      .set({
        status: error ? "failed" : "succeeded",
        model: u[0]?.model ?? null,
        provider: u[0]?.provider ?? null,
        inputTokens: sum("inputTokens"),
        outputTokens: sum("outputTokens"),
        costMicros: sum("costMicros"),
        sandboxId: result.metering.sandbox?.id ?? null,
        sandboxSeconds: result.metering.sandbox?.seconds ?? null,
        output: result.ok && !error ? { policyIds, ambiguities: result.output.ambiguities.length } : null,
        error,
        finishedAt: done,
      })
      .where(eq(agentRuns.id, runId));
    if (error) await tx.update(contracts).set({ status: "failed", error }).where(eq(contracts.id, contractId));
    await notifyEvent(tx, { orgId, type: "contract.updated", id: contractId });
    return reachedCapThresholds(tx, orgId, done);
  });
  await notifyCapThresholds(deps, orgId, thresholds);
}
