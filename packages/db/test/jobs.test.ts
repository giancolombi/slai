import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createJobSender, createProducerBoss, parseJob } from "../src/jobs.js";
import { openDbs, seedOrg, urls } from "./helpers.js";

const { owner, app } = openDbs();
const boss = createProducerBoss(urls.app);
const jobs = createJobSender(boss);
let orgId: string;

beforeAll(async () => {
  boss.on("error", () => {});
  await boss.start();
  ({ orgId } = await seedOrg(owner, 0));
});
afterAll(() => boss.stop({ graceful: false }));

const jobsFor = (contractId: string) =>
  owner.client`select name, data from pgboss.job where data->>'contractId' = ${contractId}`;

describe("transactional job enqueue (app role)", () => {
  it("commits the job with the transaction", async () => {
    const contractId = randomUUID();
    await app.withOrg(orgId, (tx) => jobs.send(tx, "extract-contract", { orgId, contractId }));
    const rows = await jobsFor(contractId);
    expect(rows).toEqual([{ name: "extract-contract", data: { orgId, contractId } }]);
  });

  it("drops the job when the transaction rolls back", async () => {
    const contractId = randomUUID();
    await expect(
      app.withOrg(orgId, async (tx) => {
        await jobs.send(tx, "extract-contract", { orgId, contractId });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await jobsFor(contractId)).toEqual([]);
  });

  it("validates payloads on both ends", async () => {
    await expect(
      app.withOrg(orgId, (tx) => jobs.send(tx, "run-agent", { orgId, runId: "not-a-uuid" })),
    ).rejects.toThrow();
    expect(() => parseJob("run-replay", { orgId })).toThrow();
    expect(parseJob("sync-connection", { orgId, connectionId: orgId })).toEqual({
      orgId,
      connectionId: orgId,
      full: false,
    });
  });
});
