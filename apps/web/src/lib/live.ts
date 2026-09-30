/**
 * Live updates (T-56): one EventSource on `GET /api/v1/events` per signed-in tab.
 *
 * - Events carry ids only; the API re-reads through RLS. So an event invalidates the
 *   TanStack Query caches that show that kind of thing, and active queries refetch.
 *   Bursts (a sync touching 200 tickets) are coalesced into one flush.
 * - The stream is bound to the session's org, so it reconnects when the org changes.
 * - On error it closes and reconnects with jittered exponential backoff (1s → 30s).
 *   After a reconnect it refetches everything, since events were missed meanwhile.
 * - While it isn't live, queries poll slowly instead (`useLivePolling`).
 */
import { API_BASE } from "@slai/shared";
import { type QueryClient, type QueryKey, useQueryClient } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";

export type LiveStatus = "off" | "connecting" | "live" | "reconnecting";
export const LIVE_EVENTS = [
  "ticket.updated",
  "action.created",
  "action.updated",
  "replay.progress",
  "contract.updated",
];

export const BACKOFF_MIN_MS = 1_000;
export const BACKOFF_MAX_MS = 30_000;
export const FLUSH_MS = 300;
/** How often queries poll while the stream is down. */
export const FALLBACK_POLL_MS = 60_000;

// ---------------------------------------------------------------- status store

let status: LiveStatus = "off";
const listeners = new Set<() => void>();
function setStatus(next: LiveStatus) {
  if (next === status) return;
  status = next;
  for (const fn of listeners) fn();
}
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
export const getLiveStatus = () => status;
export const useLiveStatus = () => useSyncExternalStore(subscribe, getLiveStatus, getLiveStatus);

/** A refetch interval that is off while live updates flow, and `ms` (a slow fallback) otherwise. */
export function useLivePolling(ms = FALLBACK_POLL_MS): number | false {
  return useLiveStatus() === "live" ? false : ms;
}

// ---------------------------------------------------------------- event → caches

/** Query keys (prefixes) an event makes stale. */
export function keysFor(type: string, id: string): QueryKey[] {
  switch (type) {
    case "ticket.updated":
      return [["tickets"], ["ticket", id], ["dashboard"]];
    case "action.created":
    case "action.updated":
      // The action's ticket isn't in the payload: refresh whichever ticket page is open.
      return [["actions"], ["ticket"], ["dashboard"]];
    case "replay.progress":
      return [["replays"]];
    case "contract.updated":
      return [["contracts"], ["policies"]];
    default:
      return [];
  }
}

/** Collects stale keys and invalidates them together, at most once per `FLUSH_MS`. */
function createFlusher(queryClient: QueryClient) {
  const pending = new Map<string, QueryKey>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null;
    const keys = [...pending.values()];
    pending.clear();
    for (const queryKey of keys) void queryClient.invalidateQueries({ queryKey });
  };
  return {
    add(keys: QueryKey[]) {
      for (const k of keys) pending.set(JSON.stringify(k), k);
      timer ??= setTimeout(flush, FLUSH_MS);
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending.clear();
    },
  };
}

export function backoffMs(attempt: number, random = Math.random) {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** attempt);
  return Math.round(base / 2 + (random() * base) / 2);
}

// ---------------------------------------------------------------- the connection

/**
 * Opens the stream and keeps it open until the returned function is called.
 * Exported for tests; the app uses `useLiveUpdates`.
 */
export function connectLive(queryClient: QueryClient, url = `${API_BASE}/events`): () => void {
  if (typeof EventSource === "undefined") {
    setStatus("off");
    return () => {};
  }
  const flusher = createFlusher(queryClient);
  let es: EventSource | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let droppedOnce = false;
  let stopped = false;

  const open = () => {
    retry = null;
    setStatus(droppedOnce ? "reconnecting" : "connecting");
    const source = new EventSource(url, { withCredentials: true });
    es = source;
    source.addEventListener("ready", () => {
      attempt = 0;
      setStatus("live");
      // Anything could have changed while we weren't listening.
      if (droppedOnce) void queryClient.invalidateQueries();
    });
    for (const type of LIVE_EVENTS) {
      source.addEventListener(type, (e) => {
        let id = "";
        try {
          id = String((JSON.parse((e as MessageEvent<string>).data) as { id?: unknown }).id ?? "");
        } catch {
          return;
        }
        if (id) flusher.add(keysFor(type, id));
      });
    }
    source.onerror = () => {
      // The browser would retry on its own, but not after a 401/5xx, and without backoff.
      source.close();
      if (stopped || es !== source) return;
      es = null;
      droppedOnce = true;
      setStatus("reconnecting");
      retry = setTimeout(open, backoffMs(attempt++));
    };
  };

  open();
  return () => {
    stopped = true;
    if (retry) clearTimeout(retry);
    es?.close();
    es = null;
    flusher.cancel();
    setStatus("off");
  };
}

/** Keeps this tab's live connection open for `orgId` (reconnects when it changes). */
export function useLiveUpdates(orgId: string | undefined, enabled = true) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!orgId || !enabled) return;
    return connectLive(queryClient);
  }, [orgId, enabled, queryClient]);
}
