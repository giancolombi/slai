import { describe, expect, it } from "vitest";
import { getConnector, listConnectors } from "../src/index.js";

const noFetch = (() => {
  throw new Error("no network in tests");
}) as unknown as typeof fetch;

const SAMPLE_CREDENTIALS: Record<string, unknown> = {
  zendesk: { subdomain: "acme", email: "a@acme.com", apiToken: "t" },
  freshdesk: { domain: "acme", apiKey: "k" },
  intercom: { accessToken: "t" },
  jira_service_management: { siteUrl: "https://acme.atlassian.net", email: "a@acme.com", apiToken: "t" },
  hubspot: { accessToken: "t" },
  zammad: { baseUrl: "https://support.acme.example", apiToken: "t" },
  salesforce: { instanceUrl: "https://acme.my.salesforce.com", clientId: "id", clientSecret: "s" },
  servicenow: { instanceUrl: "https://acme.service-now.com", username: "slai.integration", password: "p" },
  zoho_desk: {
    dataCenter: "com",
    orgId: "60012345",
    clientId: "1000.CLIENTID",
    clientSecret: "s",
    refreshToken: "1000.r.t",
  },
  front: { apiToken: "t" },
  demo: {},
};

describe("registry", () => {
  it("registers every connector and the demo", () => {
    expect(
      listConnectors()
        .map((c) => c.provider)
        .sort(),
    ).toEqual([
      "demo",
      "freshdesk",
      "front",
      "hubspot",
      "intercom",
      "jira_service_management",
      "salesforce",
      "servicenow",
      "zammad",
      "zendesk",
      "zoho_desk",
    ]);
    expect(getConnector("nope")).toBeNull();
  });

  for (const def of listConnectors()) {
    it(`${def.provider}: definition is consistent`, async () => {
      const creds = def.credentialsSchema.parse(SAMPLE_CREDENTIALS[def.provider]);
      const shape = (def.credentialsSchema as unknown as { shape: Record<string, unknown> }).shape;
      for (const f of def.credentialFields) expect(Object.keys(shape)).toContain(f.key);
      expect(Object.keys(def.defaultMapping.status).length).toBeGreaterThan(0);
      expect(def.docsUrl).toMatch(/^https:\/\//);
      const client = def.create({
        credentials: creds,
        config: { seed: "t" },
        mapping: def.defaultMapping,
        fetch: noFetch,
      });
      // Unsigned or wrongly signed deliveries never pass.
      const r = await client.handleWebhook(
        { headers: {}, rawBody: '{"ticket_id":"1"}', url: "https://api.slai.dev/webhooks/x" },
        "secret",
      );
      expect(r.ok).toBe(false);
      if (!def.supportsWebhooks) expect(r).toEqual({ ok: false, reason: "unsupported" });
      else expect(r).toEqual({ ok: false, reason: "bad_signature" });
    });
  }
});
