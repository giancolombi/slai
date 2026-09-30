/** Injectable time. Every "now" in the worker comes from here, so tests can move time. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** Start of the UTC calendar month containing `d` (billing and spend-cap periods). */
export function monthStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

export function monthKey(d: Date): string {
  return d.toISOString().slice(0, 7);
}
