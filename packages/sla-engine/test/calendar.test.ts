import { describe, expect, it } from "vitest";
import {
  ALWAYS_ON,
  addClockTime,
  CalendarError,
  clockTimeBetween,
  isWorkingTime,
  validateCalendar,
} from "../src/index.js";
import { at, NY_BUSINESS } from "./fixtures.js";

const H = 3_600_000;
const cal = NY_BUSINESS;

describe("clockTimeBetween", () => {
  it("counts only working hours within a day", () => {
    // Fri 2026-10-02 08:00 → 12:00 EDT (UTC-4): only 09:00–12:00 counts.
    expect(clockTimeBetween(at("2026-10-02T12:00:00Z"), at("2026-10-02T16:00:00Z"), cal, "business")).toBe(3 * H);
  });

  it("skips the weekend", () => {
    // Fri 16:00 EDT → Mon 10:00 EDT = 1h Fri + 1h Mon.
    expect(clockTimeBetween(at("2026-10-02T20:00:00Z"), at("2026-10-05T14:00:00Z"), cal, "business")).toBe(2 * H);
  });

  it("skips holidays", () => {
    // Mon 2026-10-12 is a holiday: Fri 16:00 → Tue 10:00 = 1h + 1h.
    expect(clockTimeBetween(at("2026-10-09T20:00:00Z"), at("2026-10-13T14:00:00Z"), cal, "business")).toBe(2 * H);
  });

  it("calendar clock ignores the schedule", () => {
    expect(clockTimeBetween(at("2026-10-02T20:00:00Z"), at("2026-10-05T14:00:00Z"), cal, "calendar")).toBe(66 * H);
  });

  it("is zero for reversed or empty spans", () => {
    expect(clockTimeBetween(at("2026-10-05T14:00:00Z"), at("2026-10-05T13:00:00Z"), cal, "business")).toBe(0);
  });

  it("handles the DST fall-back day (25h local day)", () => {
    // 24x7 in New York across 2026-11-01: midnight to midnight is 25 real hours.
    const nyAlways = { ...ALWAYS_ON, timezone: "America/New_York" };
    expect(clockTimeBetween(at("2026-11-01T04:00:00Z"), at("2026-11-02T05:00:00Z"), nyAlways, "business")).toBe(25 * H);
  });
});

describe("addClockTime", () => {
  it("rolls over the weekend", () => {
    // Fri 16:00 EDT + 2 business hours = Mon 10:00 EDT.
    expect(addClockTime(at("2026-10-02T20:00:00Z"), 2 * H, cal, "business").toISOString()).toBe(
      "2026-10-05T14:00:00.000Z",
    );
  });

  it("starts counting at opening time when started outside hours", () => {
    // Sat + 30 min = Mon 09:30 EDT.
    expect(addClockTime(at("2026-10-03T15:00:00Z"), 30 * 60_000, cal, "business").toISOString()).toBe(
      "2026-10-05T13:30:00.000Z",
    );
  });

  it("is the inverse of clockTimeBetween", () => {
    const start = at("2026-10-01T15:17:00Z");
    for (const hours of [0.5, 3, 8, 13, 40, 100]) {
      const end = addClockTime(start, hours * H, cal, "business");
      expect(clockTimeBetween(start, end, cal, "business")).toBe(hours * H);
    }
  });

  it("uses the business hours of each local day across DST", () => {
    // Fri 2026-10-30 16:00 EDT + 2h business = Mon 2026-11-02 10:00 EST (UTC-5).
    expect(addClockTime(at("2026-10-30T20:00:00Z"), 2 * H, cal, "business").toISOString()).toBe(
      "2026-11-02T15:00:00.000Z",
    );
  });

  it("returns the start for zero duration", () => {
    expect(addClockTime(at("2026-10-03T15:00:00Z"), 0, cal, "business").toISOString()).toBe("2026-10-03T15:00:00.000Z");
  });
});

describe("validateCalendar", () => {
  it("accepts a well-formed calendar", () => {
    expect(() => validateCalendar(cal)).not.toThrow();
  });
  it("rejects unknown timezones", () => {
    expect(() => validateCalendar({ ...cal, timezone: "Mars/Olympus" })).toThrow(CalendarError);
  });
  it("rejects calendars with no working time", () => {
    expect(() => validateCalendar({ timezone: "UTC", weekly: {}, holidays: [] })).toThrow(/no working hours/);
  });
  it("rejects overlapping ranges", () => {
    expect(() =>
      validateCalendar({
        timezone: "UTC",
        weekly: {
          mon: [
            { start: "09:00", end: "12:00" },
            { start: "11:00", end: "13:00" },
          ],
        },
        holidays: [],
      }),
    ).toThrow(/overlapping/);
  });
});

describe("isWorkingTime", () => {
  it("is true inside hours and false outside", () => {
    expect(isWorkingTime(at("2026-10-05T14:00:00Z"), cal)).toBe(true);
    expect(isWorkingTime(at("2026-10-05T22:00:00Z"), cal)).toBe(false);
    expect(isWorkingTime(at("2026-10-03T14:00:00Z"), cal)).toBe(false);
  });
});
