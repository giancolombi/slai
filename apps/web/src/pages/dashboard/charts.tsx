import type { DashboardSummary } from "@slai/shared";
import { cn, formatDate, formatPercent } from "@slai/ui";
import { type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from "react";
import { seriesPaths } from "./series-paths";

type TrendPoint = DashboardSummary["attainmentTrend"][number];

/** Measures an element's content width so SVG charts can draw at 1:1 pixels. */
export function useElementWidth<T extends HTMLElement>(fallback = 640) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(240, Math.floor(entry.contentRect.width)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

const shortDate = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const fmtDay = (iso: string) => shortDate.format(new Date(`${iso}T00:00:00Z`));

function niceStep(span: number) {
  if (span <= 3) return 0.5;
  if (span <= 6) return 1;
  if (span <= 12) return 2;
  return 5;
}

const PAD = { top: 12, right: 12, bottom: 24, left: 40 };

/** Both charts share one band scale (each day centred in its slot) so hover lines up across them. */
function slotX(i: number, count: number, plotW: number) {
  return PAD.left + ((i + 0.5) / Math.max(1, count)) * plotW;
}

/** Shared hover/keyboard state for one index across the linked charts. */
export function useActiveIndex(count: number) {
  const [active, setActive] = useState<number | null>(null);
  const onKeyDown = (e: KeyboardEvent) => {
    if (count === 0) return;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft" || e.key === "Home" || e.key === "End") {
      e.preventDefault();
      setActive((i) => {
        if (e.key === "Home") return 0;
        if (e.key === "End") return count - 1;
        const base = i ?? (e.key === "ArrowRight" ? -1 : count);
        return Math.min(count - 1, Math.max(0, base + (e.key === "ArrowRight" ? 1 : -1)));
      });
    } else if (e.key === "Escape") setActive(null);
  };
  return { active, setActive, onKeyDown };
}

function indexFromPointer(e: PointerEvent<SVGElement>, width: number, count: number) {
  const rect = e.currentTarget.getBoundingClientRect();
  const x = e.clientX - rect.left - PAD.left;
  const plot = width - PAD.left - PAD.right;
  return Math.min(count - 1, Math.max(0, Math.floor((x / plot) * count)));
}

interface ChartProps {
  data: TrendPoint[];
  active: number | null;
  setActive: (i: number | null) => void;
  onKeyDown: (e: KeyboardEvent) => void;
}

/**
 * Daily attainment: one series, so no legend box — the card title names it.
 * A dashed reference marks the 95% credit tier most contracts use.
 */
export function AttainmentChart({ data, active, setActive, onKeyDown }: ChartProps) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const height = 200;
  const values = data.map((d) => d.percent).filter((v): v is number => v !== null);
  const lo = Math.min(94, Math.floor((Math.min(...values) - 0.5) * 2) / 2);
  const hi = 100;
  const step = niceStep(hi - lo);
  const plotW = width - PAD.left - PAD.right;
  const plotH = height - PAD.top - PAD.bottom;
  const x = (i: number) => slotX(i, data.length, plotW);
  const y = (v: number) => PAD.top + (1 - (v - lo) / (hi - lo)) * plotH;

  const ticks: number[] = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi + 1e-9; t += step) ticks.push(Number(t.toFixed(1)));

  const lastIdx = data.findLastIndex((d) => d.percent !== null);
  const { line, area } = seriesPaths(
    data.map((d) => d.percent),
    x,
    y,
    PAD.top + plotH,
  );
  const labelEvery = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(plotW / 90))));
  const point = active !== null ? data[active] : null;
  const first = values[0];
  const last = values[values.length - 1];

  return (
    <div ref={ref} className="relative">
      {values.length === 0 && (
        <p className="absolute inset-x-0 top-1/2 z-[1] -translate-y-1/2 text-center text-sm text-ink-muted">
          No SLA cycles measured in this period yet.
        </p>
      )}
      <svg
        width={width}
        height={height}
        role="img"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: focusable so arrow keys can scrub day by day (announced via a live region)
        tabIndex={0}
        aria-label={`Daily attainment over ${data.length} days, from ${formatPercent(first)} to ${formatPercent(last)}. Use arrow keys to read each day.`}
        className="block overflow-visible rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-focus"
        onPointerMove={(e) => setActive(indexFromPointer(e, width, data.length))}
        onPointerLeave={() => setActive(null)}
        onKeyDown={onKeyDown}
        onBlur={() => setActive(null)}
      >
        <defs>
          <linearGradient id="attain-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.16} />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
          </linearGradient>
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeWidth={1} />
            <text
              x={PAD.left - 8}
              y={y(t)}
              dy="0.32em"
              textAnchor="end"
              className="fill-ink-muted font-mono text-[10px] tnum"
            >
              {t % 1 === 0 ? `${t}%` : `${t.toFixed(1)}%`}
            </text>
          </g>
        ))}
        {95 > lo && (
          <g>
            <line
              x1={PAD.left}
              x2={width - PAD.right}
              y1={y(95)}
              y2={y(95)}
              stroke="var(--text-subtle)"
              strokeDasharray="3 4"
              strokeWidth={1}
            />
            <text x={width - PAD.right} y={y(95) - 5} textAnchor="end" className="fill-ink-muted text-[10px]">
              95% credit tier
            </text>
          </g>
        )}
        {area && <path d={area} fill="url(#attain-fill)" />}
        {line && (
          <path
            d={line}
            fill="none"
            stroke="var(--accent)"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )}
        {data.map((d, i) =>
          i % labelEvery === 0 || (i === data.length - 1 && i % labelEvery >= labelEvery / 2) ? (
            <text
              key={d.date}
              x={x(i)}
              y={height - 6}
              textAnchor={i === 0 ? "start" : i === data.length - 1 ? "end" : "middle"}
              className="fill-ink-muted text-[10px]"
            >
              {fmtDay(d.date)}
            </text>
          ) : null,
        )}
        {point && active !== null && (
          <g aria-hidden>
            <line
              x1={x(active)}
              x2={x(active)}
              y1={PAD.top}
              y2={PAD.top + plotH}
              stroke="var(--text-subtle)"
              strokeWidth={1}
            />
            {point.percent !== null && (
              <circle
                cx={x(active)}
                cy={y(point.percent)}
                r={4.5}
                fill="var(--accent)"
                stroke="var(--surface)"
                strokeWidth={2}
              />
            )}
          </g>
        )}
        {!point && last !== undefined && (
          <circle
            cx={x(lastIdx)}
            cy={y(last)}
            r={4}
            fill="var(--accent)"
            stroke="var(--surface)"
            strokeWidth={2}
            aria-hidden
          />
        )}
      </svg>
      {point && active !== null && (
        <ChartTooltip x={x(active)} width={width} top={PAD.top}>
          <div className="font-medium text-ink">{formatDate(`${point.date}T12:00:00Z`)}</div>
          <div className="mt-0.5 flex items-center justify-between gap-4">
            <span className="text-ink-muted">Attainment</span>
            <span className="font-mono tnum text-ink">{formatPercent(point.percent)}</span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-ink-muted">Breaches</span>
            <span className="font-mono tnum text-ink">{point.breaches}</span>
          </div>
        </ChartTooltip>
      )}
      <div aria-live="polite" className="sr-only">
        {point ? `${fmtDay(point.date)}: ${formatPercent(point.percent)} attainment, ${point.breaches} breaches` : ""}
      </div>
    </div>
  );
}

/** Daily breach counts on the same x scale as the attainment chart (a second chart, never a second axis). */
export function BreachBars({ data, active, setActive, onKeyDown }: ChartProps) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const height = 72;
  const plotW = width - PAD.left - PAD.right;
  const plotH = height - 18;
  const max = Math.max(1, ...data.map((d) => d.breaches));
  const slot = plotW / Math.max(1, data.length);
  const barW = Math.max(2, Math.min(14, slot - 2));
  const cx = (i: number) => slotX(i, data.length, plotW);
  const total = data.reduce((s, d) => s + d.breaches, 0);

  return (
    <div ref={ref} className="relative">
      <svg
        width={width}
        height={height}
        role="img"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: focusable so arrow keys can scrub day by day (announced via a live region)
        tabIndex={0}
        aria-label={`Daily breaches, ${total} over ${data.length} days. Use arrow keys to read each day.`}
        className="block overflow-visible rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-focus"
        onPointerMove={(e) => setActive(indexFromPointer(e, width, data.length))}
        onPointerLeave={() => setActive(null)}
        onKeyDown={onKeyDown}
        onBlur={() => setActive(null)}
      >
        <line x1={PAD.left} x2={width - PAD.right} y1={plotH} y2={plotH} stroke="var(--line)" />
        <text x={PAD.left - 8} y={plotH} textAnchor="end" className="fill-ink-muted font-mono text-[10px] tnum">
          0
        </text>
        <text x={PAD.left - 8} y={8} textAnchor="end" className="fill-ink-muted font-mono text-[10px] tnum">
          {max}
        </text>
        {data.map((d, i) => {
          const h = d.breaches === 0 ? 0 : Math.max(3, (d.breaches / max) * (plotH - 6));
          const r = Math.min(3, barW / 2, h);
          const x0 = cx(i) - barW / 2;
          const y0 = plotH - h;
          return h === 0 ? null : (
            <path
              key={d.date}
              d={`M${x0},${plotH} V${y0 + r} Q${x0},${y0} ${x0 + r},${y0} H${x0 + barW - r} Q${x0 + barW},${y0} ${x0 + barW},${y0 + r} V${plotH} Z`}
              fill="var(--risk-breached-solid)"
              opacity={active === null || active === i ? 0.85 : 0.35}
            />
          );
        })}
        {active !== null && (
          <line
            x1={cx(active)}
            x2={cx(active)}
            y1={0}
            y2={plotH}
            stroke="var(--text-subtle)"
            strokeWidth={1}
            aria-hidden
          />
        )}
      </svg>
      {active !== null && data[active] && (
        <ChartTooltip x={cx(active)} width={width} top={-6} compact>
          <span className="text-ink-muted">{fmtDay(data[active].date)}</span>{" "}
          <span className="font-mono text-ink tnum">{data[active].breaches}</span>{" "}
          <span className="text-ink-muted">{data[active].breaches === 1 ? "breach" : "breaches"}</span>
        </ChartTooltip>
      )}
    </div>
  );
}

function ChartTooltip({
  x,
  width,
  top,
  compact,
  children,
}: {
  x: number;
  width: number;
  top: number;
  compact?: boolean;
  children: React.ReactNode;
}) {
  const flip = x > width - 180;
  return (
    <div
      className={cn(
        "pointer-events-none absolute z-10 rounded-md border border-line bg-raised text-xs shadow-md",
        compact ? "px-2 py-1 whitespace-nowrap" : "min-w-40 px-3 py-2",
      )}
      style={{ left: flip ? undefined : x + 12, right: flip ? width - x + 12 : undefined, top }}
    >
      {children}
    </div>
  );
}

/** The same numbers as a table, for screen readers and anyone who prefers rows. */
export function TrendTable({ data }: { data: TrendPoint[] }) {
  return (
    <table className="sr-only">
      <caption>Daily attainment and breaches</caption>
      <thead>
        <tr>
          <th scope="col">Date</th>
          <th scope="col">Attainment</th>
          <th scope="col">Breaches</th>
        </tr>
      </thead>
      <tbody>
        {data.map((d) => (
          <tr key={d.date}>
            <td>{fmtDay(d.date)}</td>
            <td>{formatPercent(d.percent)}</td>
            <td>{d.breaches}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
