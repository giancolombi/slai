import { demo } from "./connectors/demo/index.js";
import { freshdesk } from "./connectors/freshdesk.js";
import { front } from "./connectors/front.js";
import { hubspot } from "./connectors/hubspot.js";
import { intercom } from "./connectors/intercom.js";
import { jiraServiceManagement } from "./connectors/jira-service-management.js";
import { salesforce } from "./connectors/salesforce.js";
import { servicenow } from "./connectors/servicenow.js";
import { zammad } from "./connectors/zammad.js";
import { zendesk } from "./connectors/zendesk.js";
import { zohoDesk } from "./connectors/zoho-desk.js";
import type { ConnectorDefinition, ProviderId } from "./types.js";

/** Every implemented connector, keyed by provider. Add new connectors here. */
// biome-ignore lint/suspicious/noExplicitAny: each connector has its own credentials type
const REGISTRY: Partial<Record<ProviderId, ConnectorDefinition<any>>> = {
  zendesk,
  freshdesk,
  intercom,
  jira_service_management: jiraServiceManagement,
  hubspot,
  zammad,
  salesforce,
  servicenow,
  zoho_desk: zohoDesk,
  front,
  demo,
};

// biome-ignore lint/suspicious/noExplicitAny: see above
export function getConnector(provider: string): ConnectorDefinition<any> | null {
  return REGISTRY[provider as ProviderId] ?? null;
}

// biome-ignore lint/suspicious/noExplicitAny: see above
export function listConnectors(): ConnectorDefinition<any>[] {
  // biome-ignore lint/suspicious/noExplicitAny: see above
  return Object.values(REGISTRY).filter((c): c is ConnectorDefinition<any> => c !== undefined);
}
