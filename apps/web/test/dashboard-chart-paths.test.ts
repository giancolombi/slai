import { describe, expect, it } from "vitest";
import { seriesPaths } from "../src/pages/dashboard/series-paths";

const x = (i: number) => i * 10;
const y = (v: number) => 100 - v;

describe("seriesPaths", () => {
  it("draws one segment for continuous data", () => {
    const { line, area } = seriesPaths([90, 95, 99], x, y, 100);
    expect(line).toBe("M0.0,10.0L10.0,5.0L20.0,1.0");
    expect(area).toBe("M0.0,10.0L10.0,5.0L20.0,1.0L20.0,100L0.0,100Z");
  });

  it("breaks the line and area at missing days instead of bridging them", () => {
    const { line, area } = seriesPaths([90, null, 95, 96, null], x, y, 100);
    expect(line).toBe("M0.0,10.0 M20.0,5.0L30.0,4.0");
    expect(area).toBe("M0.0,10.0L0.0,100L0.0,100Z M20.0,5.0L30.0,4.0L30.0,100L20.0,100Z");
  });

  it("returns empty paths (never a bare L command) when every day is missing", () => {
    expect(seriesPaths([null, null], x, y, 100)).toEqual({ line: "", area: "" });
    expect(seriesPaths([], x, y, 100)).toEqual({ line: "", area: "" });
  });
});
