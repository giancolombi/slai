import { useId } from "react";
import { cn } from "../lib/cn";

export interface SparklineProps {
  /** Values left to right. Nulls are gaps. */
  values: (number | null)[];
  width?: number;
  height?: number;
  /** Fixed domain; defaults to the data's min/max. */
  min?: number;
  max?: number;
  /** Stroke color as a CSS value. Defaults to the accent. */
  color?: string;
  /** Soft area fill under the line. */
  area?: boolean;
  /** Emphasize the last point. */
  showLast?: boolean;
  /** Accessible summary, e.g. "Attainment over 14 days, 96% to 98%". Omit to mark decorative. */
  label?: string;
  className?: string;
}

/** A tiny, dependency-free SVG trend line. Thin 1.5px stroke, round joins, optional last-point dot. */
export function Sparkline({
  values,
  width = 96,
  height = 28,
  min,
  max,
  color = "var(--accent)",
  area = true,
  showLast = true,
  label,
  className,
}: SparklineProps) {
  const gradientId = `spark-${useId().replace(/[^\w-]/g, "")}`;
  const nums = values.filter((v): v is number => v !== null);
  if (nums.length < 2) {
    return <svg width={width} height={height} className={className} aria-hidden />;
  }
  const lo = min ?? Math.min(...nums);
  const hi = max ?? Math.max(...nums);
  const span = hi - lo || 1;
  const pad = 2.5;
  const x = (i: number) => pad + (i / (values.length - 1)) * (width - pad * 2);
  const y = (v: number) => pad + (1 - (v - lo) / span) * (height - pad * 2);

  const segments: string[] = [];
  let current = "";
  values.forEach((v, i) => {
    if (v === null) {
      if (current) segments.push(current);
      current = "";
      return;
    }
    current += `${current ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
  });
  if (current) segments.push(current);
  const line = segments.join(" ");

  const firstIdx = values.findIndex((v) => v !== null);
  let lastIdx = values.length - 1;
  while (values[lastIdx] === null) lastIdx--;
  const last = values[lastIdx] as number;
  const areaPath = `${line} L${x(lastIdx).toFixed(1)},${height} L${x(firstIdx).toFixed(1)},${height} Z`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn("overflow-visible", className)}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {area && (
        <>
          <defs>
            <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.18} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <path d={areaPath} fill={`url(#${gradientId})`} />
        </>
      )}
      <path d={line} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      {showLast && (
        <circle cx={x(lastIdx)} cy={y(last)} r={2.5} fill={color} stroke="var(--surface)" strokeWidth={1.5} />
      )}
    </svg>
  );
}
