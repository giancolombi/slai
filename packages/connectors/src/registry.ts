import { demo } from "./connectors/demo/index.js";
import type { ConnectorDefinition, ProviderId } from "./types.js";

/** Every implemented connector, keyed by provider. Add new connectors here. */
// biome-ignore lint/suspicious/noExplicitAny: each connector has its own credentials type
const REGISTRY: Partial<Record<ProviderId, ConnectorDefinition<any>>> = {
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
