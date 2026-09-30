import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatClock, SlaClock } from "../src/components/sla-clock";

const T0 = new Date("2026-03-02T15:00:00.000Z").getTime();

describe("SlaClock", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: T0 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts down every second to dueAt", () => {
    render(<SlaClock dueAt={new Date(T0 + 65_000).toISOString()} />);
    const timer = screen.getByRole("timer");
    expect(timer).toHaveTextContent("1m 05s");
    expect(timer).toHaveAccessibleName("Due in 1 minute");

    act(() => vi.advanceTimersByTime(1000));
    expect(timer).toHaveTextContent("1m 04s");

    act(() => vi.advanceTimersByTime(5000));
    expect(timer).toHaveTextContent("59s");
  });

  it("shows hours with padded minutes and seconds", () => {
    render(<SlaClock dueAt={new Date(T0 + (72 * 60 + 5) * 1000).toISOString()} />);
    expect(screen.getByRole("timer")).toHaveTextContent("1h 12m 05s");
  });

  it("flips to an overdue count-up past the due time", () => {
    render(<SlaClock dueAt={new Date(T0 + 2000).toISOString()} size="md" />);
    const timer = screen.getByRole("timer");
    act(() => vi.advanceTimersByTime(4000));
    expect(timer).toHaveTextContent("+2s");
    expect(timer).toHaveTextContent("overdue");
    expect(timer.getAttribute("aria-label")).toMatch(/^Overdue by/);
  });

  it("freezes while paused and ignores dueAt", () => {
    render(<SlaClock dueAt={null} state="paused" remainingMs={3 * 3_600_000 + 4 * 60_000} />);
    const timer = screen.getByRole("timer");
    expect(timer).toHaveTextContent("3h 04m 00s");
    expect(timer).toHaveTextContent("paused");
    expect(timer).toHaveAccessibleName("Paused with 3 hours 4 minutes left");

    act(() => vi.advanceTimersByTime(10_000));
    expect(timer).toHaveTextContent("3h 04m 00s");
  });

  it("does not tick when resumed clocks are given a fixed now", () => {
    render(<SlaClock dueAt={new Date(T0 + 10_000).toISOString()} now={T0} />);
    act(() => vi.advanceTimersByTime(3000));
    expect(screen.getByRole("timer")).toHaveTextContent("10s");
  });

  it("renders met and not-applicable states", () => {
    const { rerender } = render(<SlaClock dueAt={null} state="achieved" />);
    expect(screen.getByRole("timer")).toHaveTextContent("Met");
    rerender(<SlaClock dueAt={null} state="not_applicable" />);
    expect(screen.getByRole("timer")).toHaveAccessibleName("Not measured");
  });
});

describe("formatClock", () => {
  it("uses days, hours and minutes above a day", () => {
    expect(formatClock((3 * 24 + 4) * 3_600_000 + 7 * 60_000)).toBe("3d 04h 07m");
  });
});
