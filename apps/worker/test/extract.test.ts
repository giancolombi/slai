import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { agentRuns, contracts, customerAccounts, slaPolicies, usageLedger } from "@slai/db";
import { parsePolicy } from "@slai/sla-engine";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createCustomer, createOrg, setupWorker } from "./harness.js";

const h = setupWorker();
const { owner } = h;
let orgId: string;
let customerId: string;

const FIXTURE = fileURLToPath(new URL("../../../packages/agents/test/fixtures/acme-support-sla.md", import.meta.url));

async function upload(body: Uint8Array, mediaType: string, filename: string) {
  const id = crypto.randomUUID();
  const storageKey = `${orgId}/contracts/${id}`;
  await h.deps.storage.put(storageKey, body, { contentType: mediaType, sha256: "x" });
  await owner.db.insert(contracts).values({
    id,
    orgId,
    customerAccountId: customerId,
    storageKey,
    filename,
    sha256: "x",
    mediaType,
    sizeBytes: body.length,
  });
  return id;
}

beforeAll(async () => {
  orgId = await createOrg(owner);
  customerId = await createCustomer(owner, orgId, { name: "Acme Logistics", domains: ["acme.example"], fee: null });
});

describe("extract-contract", () => {
  it("creates draft policies with citations and ambiguities, and fills in the customer's fee", async () => {
    const id = await upload(new Uint8Array(await readFile(FIXTURE)), "text/markdown", "acme-support-sla.md");
    await h.queue.send("extract-contract", { orgId, contractId: id });
    await h.drain();

    const [c] = await owner.db.select().from(contracts).where(eq(contracts.id, id));
    expect(c!.status).toBe("needs_review");
    const x = c!.extraction as {
      summary: string;
      policyIds: string[];
      citations: { quote: string }[];
      ambiguities: { path: string; question: string }[];
    };
    expect(x.summary.length).toBeGreaterThan(0);
    expect(x.policyIds).toHaveLength(2);
    expect(x.citations.length).toBeGreaterThan(5);
    expect(x.ambiguities.length).toBeGreaterThan(0);

    const policies = await owner.db.select().from(slaPolicies).where(eq(slaPolicies.contractId, id));
    expect(policies.map((p) => p.id).sort()).toEqual([...x.policyIds].sort());
    for (const p of policies) {
      expect(p.status).toBe("draft");
      expect(p.lineageId).toBe(p.id);
      expect(() => parsePolicy(p.definition)).not.toThrow();
      expect((p.definition as { id: string }).id).toBe(p.id);
    }

    const [acct] = await owner.db.select().from(customerAccounts).where(eq(customerAccounts.id, customerId));
    expect(acct!.monthlyFeeCents).toBe(1_250_000);

    const [run] = await owner.db.select().from(agentRuns).where(eq(agentRuns.contractId, id));
    expect(run!.status).toBe("succeeded");
    const ledger = await owner.db.select().from(usageLedger).where(eq(usageLedger.contractId, id));
    expect(ledger.length).toBeGreaterThan(0);
    expect(ledger.every((l) => l.kind === "model_call" && l.agentRunId === run!.id)).toBe(true);
  });

  it("marks the contract failed when the file cannot be read", async () => {
    const id = crypto.randomUUID();
    await owner.db.insert(contracts).values({
      id,
      orgId,
      storageKey: `${orgId}/contracts/${id}`,
      filename: "missing.txt",
      sha256: "x",
      mediaType: "text/plain",
      sizeBytes: 1,
    });
    await h.queue.send("extract-contract", { orgId, contractId: id });
    await h.drain();
    const [c] = await owner.db.select().from(contracts).where(eq(contracts.id, id));
    expect(c!.status).toBe("failed");
    expect(c!.error).toMatch(/extraction failed/);
    const [run] = await owner.db.select().from(agentRuns).where(eq(agentRuns.contractId, id));
    expect(run!.status).toBe("failed");
  });
});
