import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SlaBar } from "../src/components/sla-bar";
import { riskForFraction } from "../src/lib/risk";

const HOUR = 3_600_000;

describe("riskForFraction", () => {
  it.each([
    [0, "ok"],
    [0.49, "ok"],
    [0.5, "warning"],
    [0.79, "warning"],
    [0.8, "at_risk"],
    [1, "at_risk"],
    [1.0001, "breached"],
  ] as const)("%s of target is %s", (fraction, risk) => {
    expect(riskForFraction(fraction)).toBe(risk);
  });

  it("honours custom thresholds", () => {
    expect(riskForFraction(0.6, [0.7, 0.9])).toBe("ok");
    expect(riskForFraction(0.75, [0.7, 0.9])).toBe("warning");
    expect(riskForFraction(0.95, [0.7, 0.9])).toBe("at_risk");
  });
});

describe("SlaBar", () => {
  it("fills to the fraction consumed and derives risk from thresholds", () => {
    render(<SlaBar label="First response" elapsedMs={0.62 * HOUR} targetMs={HOUR} />);
    const meter = screen.getByRole("meter", { name: "First response" });
    expect(meter).toHaveAttribute("aria-valuenow", "62");
    expect(meter).toHaveAttribute("aria-valuetext", "62% of target used, warning");
    expect(meter).toHaveAttribute("data-risk", "warning");
    const fill = meter.querySelector<HTMLElement>('[data-part="fill"]')!;
    expect(fill.style.width).toBe("62%");
  });

  it("draws a marker at each warn threshold", () => {
    render(<SlaBar label="Resolution" elapsedMs={0} targetMs={HOUR} warnAt={[0.6, 0.9]} />);
    const marks = screen.getByRole("meter").querySelectorAll<HTMLElement>('[data-part="threshold"]');
    expect([...marks].map((m) => m.style.left)).toEqual(["60%", "90%"]);
  });

  it("caps the fill at 100% and reports breached past the target", () => {
    render(<SlaBar label="Next response" elapsedMs={1.4 * HOUR} targetMs={HOUR} showScale />);
    const meter = screen.getByRole("meter");
    expect(meter).toHaveAttribute("data-risk", "breached");
    expect(meter).toHaveAttribute("aria-valuenow", "100");
    expect(meter.querySelector<HTMLElement>('[data-part="fill"]')!.style.width).toBe("100%");
    expect(screen.getByText("140%")).toBeInTheDocument();
  });

  it("prefers the server risk when given", () => {
    render(<SlaBar label="First response" elapsedMs={0.1 * HOUR} targetMs={HOUR} risk="at_risk" />);
    expect(screen.getByRole("meter")).toHaveAttribute("data-risk", "at_risk");
  });

  it("renders unmeasured metrics without a fill", () => {
    render(<SlaBar label="Periodic update" elapsedMs={0} targetMs={null} />);
    const meter = screen.getByRole("meter");
    expect(meter).toHaveAttribute("aria-valuetext", "Not measured");
    expect(meter.querySelector('[data-part="fill"]')).toBeNull();
  });
});
