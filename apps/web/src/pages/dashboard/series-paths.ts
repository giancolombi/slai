/**
 * SVG paths for a daily series with gaps. Days with no measurement (null) break the
 * line and the area rather than bridging them, so a missing day never looks measured.
 */
export function seriesPaths(
  values: (number | null)[],
  x: (i: number) => number,
  y: (v: number) => number,
  baseline: number,
): { line: string; area: string } {
  const segments: { i: number; v: number }[][] = [];
  let current: { i: number; v: number }[] = [];
  values.forEach((v, i) => {
    if (v === null) {
      if (current.length) segments.push(current);
      current = [];
    } else current.push({ i, v });
  });
  if (current.length) segments.push(current);

  const pt = (p: { i: number; v: number }) => `${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`;
  const lines = segments.map((s) => s.map((p, k) => `${k ? "L" : "M"}${pt(p)}`).join(""));
  const areas = segments.map((s, n) => {
    const first = s[0]!;
    const last = s[s.length - 1]!;
    return `${lines[n]}L${x(last.i).toFixed(1)},${baseline}L${x(first.i).toFixed(1)},${baseline}Z`;
  });
  return { line: lines.join(" "), area: areas.join(" ") };
}
