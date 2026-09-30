import { useSyncExternalStore } from "react";

/**
 * One shared 1-second ticker for every live clock on the page, so sixty SlaClocks
 * cost one timer. Values are floored to whole seconds and ticks are aligned to
 * wall-clock seconds, so every clock on screen changes in the same frame.
 */
const listeners = new Set<() => void>();
let now = floorSecond(Date.now());
let timer: ReturnType<typeof setTimeout> | null = null;

function floorSecond(ms: number) {
  return Math.floor(ms / 1000) * 1000;
}

function schedule() {
  timer = setTimeout(
    () => {
      now = floorSecond(Date.now());
      for (const l of listeners) l();
      schedule();
    },
    1000 - (Date.now() % 1000),
  );
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) schedule();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

function getSnapshot() {
  // While idle nobody refreshes `now`, so read the clock (stable within a second).
  if (listeners.size === 0) now = floorSecond(Date.now());
  return now;
}

function noopSubscribe() {
  return () => {};
}

/** Current epoch ms (whole seconds), re-rendering every second while `live`. */
export function useNow(live = true): number {
  return useSyncExternalStore(live ? subscribe : noopSubscribe, getSnapshot, getSnapshot);
}
