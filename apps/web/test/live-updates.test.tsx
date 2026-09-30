import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, renderHook, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveIndicator } from "../src/components/live-indicator";
import {
  BACKOFF_MAX_MS,
  FALLBACK_POLL_MS,
  FLUSH_MS,
  getLiveStatus,
  useLivePolling,
  useLiveUpdates,
} from "../src/lib/live";

/** A scriptable stand-in for the browser's EventSource. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, ((e: MessageEvent) => void)[]>();
  onerror: (() => void) | null = null;
  closed = false;
  constructor(
    readonly url: string,
    readonly init?: EventSourceInit,
  ) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data: unknown = {}) {
    for (const fn of this.listeners.get(type) ?? []) fn(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
  fail() {
    this.onerror?.();
  }
  static get last() {
    return FakeEventSource.instances.at(-1)!;
  }
}

let client: QueryClient;
let invalidated: unknown[][];
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  client = new QueryClient();
  invalidated = [];
  vi.spyOn(client, "invalidateQueries").mockImplementation(async (filters) => {
    invalidated.push((filters?.queryKey as unknown[]) ?? ["*"]);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useLiveUpdates", () => {
  it("opens one credentialed stream per org and goes live on `ready`", () => {
    const { rerender, unmount } = renderHook(({ org }) => useLiveUpdates(org), {
      wrapper,
      initialProps: { org: "org-1" },
    });
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.last.url).toBe("/api/v1/events");
    expect(FakeEventSource.last.init).toEqual({ withCredentials: true });
    expect(getLiveStatus()).toBe("connecting");
    act(() => FakeEventSource.last.emit("ready"));
    expect(getLiveStatus()).toBe("live");

    // Switching org reconnects: the stream is bound to the session's org.
    rerender({ org: "org-2" });
    expect(FakeEventSource.instances[0]!.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(2);
    unmount();
    expect(FakeEventSource.last.closed).toBe(true);
    expect(getLiveStatus()).toBe("off");
  });

  it("invalidates the caches an event touches, coalescing a burst into one flush", () => {
    renderHook(() => useLiveUpdates("org-1"), { wrapper });
    const es = FakeEventSource.last;
    act(() => {
      es.emit("ready");
      es.emit("ticket.updated", { id: "t1" });
      es.emit("ticket.updated", { id: "t1" });
      es.emit("ticket.updated", { id: "t2" });
    });
    expect(invalidated).toEqual([]);
    act(() => vi.advanceTimersByTime(FLUSH_MS));
    expect(invalidated).toEqual([["tickets"], ["ticket", "t1"], ["dashboard"], ["ticket", "t2"]]);

    invalidated = [];
    act(() => {
      es.emit("action.updated", { id: "a1" });
      es.emit("replay.progress", { id: "r1" });
      es.emit("contract.updated", { id: "c1" });
      es.emit("ticket.updated", "not json with an id");
      vi.advanceTimersByTime(FLUSH_MS);
    });
    expect(invalidated).toEqual([["actions"], ["ticket"], ["dashboard"], ["replays"], ["contracts"], ["policies"]]);
  });

  it("reconnects with growing, capped backoff, then refetches everything it may have missed", () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    renderHook(() => useLiveUpdates("org-1"), { wrapper });
    act(() => FakeEventSource.last.emit("ready"));

    act(() => FakeEventSource.last.fail());
    expect(FakeEventSource.last.closed).toBe(true);
    expect(getLiveStatus()).toBe("reconnecting");
    act(() => vi.advanceTimersByTime(999));
    expect(FakeEventSource.instances).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1));
    expect(FakeEventSource.instances).toHaveLength(2);

    // Keeps failing: 2s, 4s, ... never more than the cap.
    const delays: number[] = [];
    for (let i = 0; i < 8; i++) {
      act(() => FakeEventSource.last.fail());
      const before = FakeEventSource.instances.length;
      let waited = 0;
      while (FakeEventSource.instances.length === before) {
        act(() => vi.advanceTimersByTime(500));
        waited += 500;
      }
      delays.push(waited);
    }
    expect(delays.slice(0, 3)).toEqual([2000, 4000, 8000]);
    expect(Math.max(...delays)).toBe(BACKOFF_MAX_MS);

    invalidated = [];
    act(() => FakeEventSource.last.emit("ready"));
    expect(getLiveStatus()).toBe("live");
    expect(invalidated).toEqual([["*"]]);
  });

  it("polls slowly only while the stream is down, and shows it", () => {
    const { result } = renderHook(
      () => {
        useLiveUpdates("org-1");
        return useLivePolling();
      },
      { wrapper },
    );
    expect(result.current).toBe(FALLBACK_POLL_MS);
    act(() => FakeEventSource.last.emit("ready"));
    expect(result.current).toBe(false);

    render(<LiveIndicator />);
    expect(screen.getByRole("status")).toHaveTextContent("Live");
    act(() => FakeEventSource.last.fail());
    expect(result.current).toBe(FALLBACK_POLL_MS);
    expect(screen.getByRole("status")).toHaveTextContent("Reconnecting");
  });
});
