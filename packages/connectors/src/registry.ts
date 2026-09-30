import type { ConnectorDefinition, ProviderId } from "./types.js";

/**
 * Every implemented connector, keyed by provider. Add new connectors here.
 * (Stub: implementations land in the connectors workstream.)
 */
const REGISTRY: Partial<Record<ProviderId, ConnectorDefinition<any>>> = {};

export function getConnector(provider: string): ConnectorDefinition<any> | null {
  return REGISTRY[provider as ProviderId] ?? null;
}

export function listConnectors(): ConnectorDefinition<any>[] {
  return Object.values(REGISTRY).filter((c): c is ConnectorDefinition<any> => c !== undefined);
}
