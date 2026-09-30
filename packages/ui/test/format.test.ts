import { describe, expect, it } from "vitest";
import { formatDuration, formatDurationLong, formatMoney } from "../src/lib/format";

const M = 60_000;
const H = 60 * M;
const D = 24 * H;

describe("formatDuration", () => {
  it.each([
    [72 * M, "1h 12m"],
    [3 * D + 4 * H + 30 * M, "3d 4h"],
    [42_000, "42s"],
    [0, "0s"],
    [5 * M + 59_000, "5m"],
    [2 * H, "2h"],
    [-90 * M, "1h 30m"],
  ])("%s ms → %s", (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });

  it("pads trailing units for clocks", () => {
    expect(formatDuration(H + 2 * M + 5000, { units: 3, smallest: "s", pad: true })).toBe("1h 02m 05s");
  });

  it("phrases durations for screen readers", () => {
    expect(formatDurationLong(72 * M)).toBe("1 hour 12 minutes");
    expect(formatDurationLong(D + M)).toBe("1 day 1 minute");
    expect(formatDurationLong(10_000)).toBe("less than a minute");
  });
});

describe("formatMoney", () => {
  it("formats integer cents as USD", () => {
    expect(formatMoney(1_234_500)).toBe("$12,345");
    expect(formatMoney(1999, "exact")).toBe("$19.99");
    expect(formatMoney(4_820_000, "compact")).toBe("$48.2K");
  });
});
