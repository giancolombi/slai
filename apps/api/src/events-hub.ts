import { type Database, EVENTS_CHANNEL, parseEvent, type RealtimeEvent } from "@slai/db";

type Listener = (e: RealtimeEvent) => void;

/** Fans out `slai_events` notifications to in-process subscribers, by org. */
export interface EventHub {
  subscribe(orgId: string, fn: Listener): () => void;
  close(): Promise<void>;
}

/** One LISTEN connection per process, opened on first subscribe. */
export function createEventHub(client: Database["client"]): EventHub {
  const byOrg = new Map<string, Set<Listener>>();
  let listening: Promise<{ unlisten(): Promise<void> }> | null = null;

  const dispatch = (payload: string) => {
    const e = parseEvent(payload);
    if (!e) return;
    for (const fn of byOrg.get(e.orgId) ?? []) fn(e);
  };

  return {
    subscribe(orgId, fn) {
      listening ??= client.listen(EVENTS_CHANNEL, dispatch);
      const set = byOrg.get(orgId) ?? new Set<Listener>();
      byOrg.set(orgId, set);
      set.add(fn);
      return () => {
        set.delete(fn);
        if (set.size === 0) byOrg.delete(orgId);
      };
    },
    async close() {
      if (listening) await (await listening).unlisten();
      listening = null;
      byOrg.clear();
    },
  };
}
