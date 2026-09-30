import { DateTime } from "luxon";
import type { BusinessCalendar, ClockKind, LocalTime, Weekday } from "./types.js";

const WEEKDAYS: Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/** Upper bound on how far we search for working time before declaring the calendar unusable. */
const MAX_SEARCH_DAYS = 366 * 3;

export class CalendarError extends Error {}

export function parseLocalTime(t: LocalTime): { hour: number; minute: number } {
  const m = /^(\d{2}):(\d{2})$/.exec(t);
  if (!m) throw new CalendarError(`invalid local time "${t}" (expected HH:mm)`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  const isEndOfDay = hour === 24 && minute === 0;
  if (!isEndOfDay && (hour > 23 || minute > 59)) {
    throw new CalendarError(`invalid local time "${t}"`);
  }
  return { hour, minute };
}

function minutesOf(t: LocalTime): number {
  const { hour, minute } = parseLocalTime(t);
  return hour * 60 + minute;
}

/** Throws CalendarError describing the first problem found. */
export function validateCalendar(cal: BusinessCalendar): void {
  if (!DateTime.local().setZone(cal.timezone).isValid) {
    throw new CalendarError(`unknown timezone "${cal.timezone}"`);
  }
  let anyWorking = false;
  for (const day of WEEKDAYS) {
    const ranges = [...(cal.weekly[day] ?? [])].sort((a, b) => minutesOf(a.start) - minutesOf(b.start));
    let prevEnd = -1;
    for (const r of ranges) {
      const s = minutesOf(r.start);
      const e = minutesOf(r.end);
      if (s >= 24 * 60) throw new CalendarError(`${day}: range cannot start at 24:00`);
      if (e <= s) throw new CalendarError(`${day}: range ${r.start}-${r.end} ends before it starts`);
      if (s < prevEnd) throw new CalendarError(`${day}: overlapping ranges`);
      prevEnd = e;
      anyWorking = true;
    }
  }
  if (!anyWorking) throw new CalendarError("calendar has no working hours");
  for (const h of cal.holidays) {
    if (!DateTime.fromISO(h, { zone: cal.timezone }).isValid || !/^\d{4}-\d{2}-\d{2}$/.test(h)) {
      throw new CalendarError(`invalid holiday date "${h}"`);
    }
  }
}

/** The continuous 24x7 calendar used for `clock: "calendar"` targets. */
export const ALWAYS_ON: BusinessCalendar = {
  timezone: "UTC",
  weekly: Object.fromEntries(WEEKDAYS.map((d) => [d, [{ start: "00:00", end: "24:00" }]])),
  holidays: [],
};

function atLocal(day: DateTime, t: LocalTime): DateTime {
  const { hour, minute } = parseLocalTime(t);
  if (hour === 24) return day.plus({ days: 1 }).startOf("day");
  // Luxon shifts non-existent DST-gap times forward, which is what we want.
  return day.set({ hour, minute, second: 0, millisecond: 0 });
}

/**
 * Yields working intervals [startMs, endMs) in chronological order, beginning
 * with the local day that contains `fromMs`. Intervals may begin before
 * `fromMs`; callers clip. Stops after MAX_SEARCH_DAYS days.
 */
function* workingIntervals(cal: BusinessCalendar, fromMs: number): Generator<[number, number]> {
  const holidays = new Set(cal.holidays);
  let day = DateTime.fromMillis(fromMs, { zone: cal.timezone }).startOf("day");
  for (let i = 0; i < MAX_SEARCH_DAYS; i++, day = day.plus({ days: 1 })) {
    if (holidays.has(day.toISODate() ?? "")) continue;
    const weekday = WEEKDAYS[day.weekday - 1] as Weekday;
    const ranges = [...(cal.weekly[weekday] ?? [])].sort((a, b) => minutesOf(a.start) - minutesOf(b.start));
    for (const r of ranges) {
      const s = atLocal(day, r.start).toMillis();
      const e = atLocal(day, r.end).toMillis();
      if (e > s) yield [s, e];
    }
  }
}

function calendarFor(cal: BusinessCalendar, kind: ClockKind): BusinessCalendar | null {
  return kind === "calendar" ? null : cal;
}

/** Clock time (ms) that elapses between `a` and `b` (0 if b <= a). */
export function clockTimeBetween(a: Date, b: Date, cal: BusinessCalendar, kind: ClockKind): number {
  const start = a.getTime();
  const end = b.getTime();
  if (end <= start) return 0;
  const c = calendarFor(cal, kind);
  if (!c) return end - start;
  let total = 0;
  for (const [s, e] of workingIntervals(c, start)) {
    if (s >= end) break;
    const lo = Math.max(s, start);
    const hi = Math.min(e, end);
    if (hi > lo) total += hi - lo;
  }
  return total;
}

/**
 * The wall-clock instant at which `ms` of clock time will have elapsed,
 * starting from `start`. With ms = 0 during non-working time this returns
 * `start` itself (the clock is already at the target).
 */
export function addClockTime(start: Date, ms: number, cal: BusinessCalendar, kind: ClockKind): Date {
  if (ms < 0) throw new RangeError("ms must be >= 0");
  const from = start.getTime();
  if (ms === 0) return new Date(from);
  const c = calendarFor(cal, kind);
  if (!c) return new Date(from + ms);
  let remaining = ms;
  for (const [s, e] of workingIntervals(c, from)) {
    if (e <= from) continue;
    const lo = Math.max(s, from);
    const available = e - lo;
    if (remaining <= available) return new Date(lo + remaining);
    remaining -= available;
  }
  throw new CalendarError(`no working time found within ${MAX_SEARCH_DAYS} days`);
}

/** Whether `at` falls inside working time. */
export function isWorkingTime(at: Date, cal: BusinessCalendar): boolean {
  const t = at.getTime();
  for (const [s, e] of workingIntervals(cal, t)) {
    if (s > t) return false;
    if (t >= s && t < e) return true;
  }
  return false;
}
