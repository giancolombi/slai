import { RISK_META, RISKS, RiskBadge } from "@slai/ui";
import { Code, Example, Section, Swatch, TokenTable } from "./doc";

const INK = ["0", "25", "50", "100", "150", "200", "300", "400", "500", "600", "700", "800", "850", "900", "950"];
const DIAL = ["50", "100", "200", "300", "400", "500", "600", "700", "800", "900"];

/** Measured WCAG 2.2 ratios for the risk roles (see tokens.css). */
const RISK_CONTRAST: Record<string, { light: [string, string, string]; dark: [string, string, string] }> = {
  ok: { light: ["5.91", "6.65", "3.60"], dark: ["8.28", "9.51", "6.27"] },
  warning: { light: ["5.66", "6.31", "3.58"], dark: ["9.14", "10.44", "7.61"] },
  at_risk: { light: ["5.64", "6.59", "3.54"], dark: ["7.77", "8.60", "6.19"] },
  breached: { light: ["5.75", "6.72", "4.85"], dark: ["6.83", "7.30", "4.80"] },
};

const ROLES: [string, string, string, string][] = [
  ["--canvas", "bg-canvas", "App background behind surfaces", "ink-50 / ink-950"],
  ["--surface", "bg-surface", "Cards, tables, inputs", "white / ink-900"],
  ["--raised", "bg-raised", "Menus, dialogs, toasts", "white / ink-850"],
  ["--sunken", "bg-sunken", "Wells, code, track of bars", "ink-100 / #0b0c0f"],
  ["--line / --line-strong", "border-line, border-line-strong", "Dividers; control borders", "ink-150 / ink-200"],
  ["--text", "text-ink", "Primary text (17.8:1 / 15.3:1)", "ink-900 / #eceef2"],
  ["--text-muted", "text-ink-muted", "Secondary text (5.9:1 / 6.8:1)", "ink-600 / #9aa1ae"],
  ["--text-subtle", "text-ink-subtle", "Placeholders, icons, decoration only", "ink-400 / #6d7482"],
  ["--accent", "bg-accent, text-accent-text", "Primary actions, focus, selection", "dial-600 / dial-400"],
  ["--focus", "outline / ring", "2px focus ring on every interactive element", "dial-500 / dial-400"],
];

export function Foundations() {
  return (
    <>
      <Section
        id="principles"
        title="Principles"
        lead="slai is used when a contract is at stake. The interface should feel calm, exact and accountable. Time is the core material."
      >
        <div className="grid gap-4 md:grid-cols-3">
          {[
            [
              "Calm by default",
              "Neutral graphite surfaces. Color is reserved for meaning: the accent for action, risk colors for risk. Nothing decorative competes with a breach.",
            ],
            [
              "Precise numbers",
              "Every clock, count and dollar is set in tabular mono so digits don't jitter as they tick. Durations read like “1h 12m”; money is USD from integer cents.",
            ],
            [
              "Evidence over assertion",
              "Numbers come with provenance: citations for contract terms, timelines for breaches. Risk is always icon + label + color, never color alone.",
            ],
          ].map(([t, d]) => (
            <div key={t} className="rounded-lg border border-line bg-surface p-4">
              <p className="text-sm font-semibold text-ink">{t}</p>
              <p className="mt-1 text-sm text-ink-muted">{d}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section
        id="color"
        title="Color"
        lead={
          <>
            Three layers: primitive scales (<Code>--ink-*</Code>, <Code>--dial-*</Code>), semantic roles that swap per
            theme, and Tailwind utilities generated from the roles by <Code>@theme</Code>. Components only use roles.
            The default Tailwind palette is removed so off-system colors fail loudly.
          </>
        }
      >
        <Example title="Ink — cool graphite neutral" className="grid grid-cols-5 gap-3 sm:grid-cols-8 lg:grid-cols-15">
          {INK.map((s) => (
            <Swatch key={s} value={`var(--ink-${s})`} label={s} />
          ))}
        </Example>
        <Example title="Dial — the brand accent (ultramarine)" className="grid grid-cols-5 gap-3 sm:grid-cols-10">
          {DIAL.map((s) => (
            <Swatch key={s} value={`var(--dial-${s})`} label={s} />
          ))}
        </Example>
        <TokenTable
          head={["Role", "Utility", "Use", "Light / dark"]}
          rows={ROLES.map(([role, util, use, value]) => [
            <Code key="r">{role}</Code>,
            <span key="u" className="font-mono text-xs text-ink-muted">
              {util}
            </span>,
            use,
            <span key="v" className="font-mono text-xs text-ink-muted">
              {value}
            </span>,
          ])}
        />
      </Section>

      <Section
        id="risk"
        title="Risk colors"
        lead="The four SLA risk levels are semantic, reserved, and never reused for anything else. Each has a text, subtle, border and solid role. Text roles meet 4.5:1 on their subtle fill and on surfaces; solid marks meet 3:1 against surfaces, in both themes. The risk itself always comes from the engine; the UI only displays it."
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {RISKS.map((r) => {
            const m = RISK_META[r];
            return (
              <div key={r} className={`rounded-lg border p-4 ${m.border} ${m.subtle}`}>
                <RiskBadge risk={r} />
                <p className={`mt-3 text-sm font-medium ${m.text}`}>{m.description}</p>
                <div className="mt-3 flex items-center gap-2">
                  <span className={`h-2 flex-1 rounded-full ${m.solid}`} />
                  <span className="font-mono text-2xs text-ink-muted">--risk-{r}-*</span>
                </div>
              </div>
            );
          })}
        </div>
        <TokenTable
          head={[
            "Risk",
            "Text on subtle",
            "Text on surface",
            "Solid on surface",
            "Dark: text/subtle",
            "Dark: text/surface",
            "Dark: solid",
          ]}
          rows={RISKS.map((r) => [
            <RiskBadge key="b" risk={r} size="sm" />,
            ...RISK_CONTRAST[r]!.light.map((v) => (
              <span key={`l${v}`} className="font-mono text-xs tnum">
                {v}:1
              </span>
            )),
            ...RISK_CONTRAST[r]!.dark.map((v) => (
              <span key={`d${v}`} className="font-mono text-xs tnum">
                {v}:1
              </span>
            )),
          ])}
        />
      </Section>

      <Section
        id="type"
        title="Typography"
        lead="Instrument Sans for the interface, JetBrains Mono for anything that ticks or lines up in a column, and Newsreader only for words quoted from a contract. All three load from Google Fonts."
      >
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="rounded-lg border border-line bg-surface p-5">
            <p className="text-2xs font-semibold tracking-wide text-ink-subtle uppercase">Sans · --typeface-sans</p>
            <p className="mt-3 text-3xl font-semibold tracking-tight">Never miss an SLA.</p>
            <p className="mt-2 text-sm text-ink-muted">
              UI text, headings and labels. 400–700, tight tracking on headings.
            </p>
          </div>
          <div className="rounded-lg border border-line bg-surface p-5">
            <p className="text-2xs font-semibold tracking-wide text-ink-subtle uppercase">Mono · --typeface-mono</p>
            <p className="mt-3 font-mono text-3xl font-medium tracking-tight tnum">01h 12m 05s</p>
            <p className="mt-2 text-sm text-ink-muted">
              Timers, numbers, keys. Use with <Code>.tnum</Code> for tabular, slashed-zero figures.
            </p>
          </div>
          <div className="rounded-lg border border-line bg-surface p-5">
            <p className="text-2xs font-semibold tracking-wide text-ink-subtle uppercase">Serif · --typeface-serif</p>
            <p className="mt-3 font-serif text-2xl">“acknowledge within thirty (30) minutes”</p>
            <p className="mt-2 text-sm text-ink-muted">
              Contract quotations only, so the source language is visibly distinct.
            </p>
          </div>
        </div>
        <TokenTable
          head={["Utility", "Size / line", "Use", "Sample"]}
          rows={[
            ["text-4xl", "38 / 44", "Report hero numbers", "$48,625"],
            ["text-3xl", "30 / 36", "Big clocks", "3h 04m"],
            ["text-2xl", "24 / 32", "Page titles, stat values", "Dashboard"],
            ["text-xl", "20 / 28", "Section titles", "Targets"],
            ["text-lg", "17 / 26", "Emphasis", "Review the policy"],
            ["text-md", "15 / 24", "Dialog titles", "Invite a teammate"],
            ["text-base", "14 / 22", "Body default", "The quick brown fox"],
            ["text-sm", "13 / 20", "Controls, tables", "Approve & send"],
            ["text-xs", "12 / 16", "Meta, badges", "Updated 3m ago"],
            ["text-2xs", "11 / 16", "Table headers, eyebrows", "FIRST RESPONSE"],
          ].map(([u, s, use, sample]) => [
            <Code key="u">{u}</Code>,
            <span key="s" className="font-mono text-xs tnum">
              {s}
            </span>,
            use,
            <span key="x" className={u}>
              {sample}
            </span>,
          ])}
        />
      </Section>

      <Section
        id="space"
        title="Space, radius, elevation"
        lead="A 4px grid (Tailwind spacing: p-1 = 4px). Radii are small and consistent: controls 7px, cards 10px, dialogs 14px. Shadows are tight and layered with a hairline so surfaces separate without floating."
      >
        <Example title="Spacing (--space-*)" className="items-end">
          {[1, 2, 3, 4, 5, 6, 8, 10, 12, 16].map((n) => (
            <div key={n} className="flex flex-col items-center gap-1.5">
              <div className="bg-accent/70 rounded-xs" style={{ width: n * 4, height: n * 4 }} />
              <span className="font-mono text-2xs text-ink-muted">
                {n} · {n * 4}px
              </span>
            </div>
          ))}
        </Example>
        <Example title="Radius (--corner-*)">
          {[
            ["xs", "3px"],
            ["sm", "5px"],
            ["md", "7px"],
            ["lg", "10px"],
            ["xl", "14px"],
          ].map(([k, v]) => (
            <div key={k} className="flex flex-col items-center gap-1.5">
              <div
                className="size-14 border border-line-strong bg-sunken"
                style={{ borderRadius: `var(--corner-${k})` }}
              />
              <span className="font-mono text-2xs text-ink-muted">
                rounded-{k} · {v}
              </span>
            </div>
          ))}
        </Example>
        <Example title="Elevation (--elev-*)" className="gap-6 bg-canvas">
          {["xs", "sm", "md", "lg"].map((k) => (
            <div key={k} className="flex flex-col items-center gap-2">
              <div className="size-20 rounded-lg bg-surface" style={{ boxShadow: `var(--elev-${k})` }} />
              <span className="font-mono text-2xs text-ink-muted">shadow-{k}</span>
            </div>
          ))}
        </Example>
      </Section>

      <Section
        id="motion"
        title="Motion"
        lead="Motion confirms, it doesn't decorate. Everything eases out fast. Every transition and entrance animation reads its duration from a token, and prefers-reduced-motion sets all of them to 0ms and stops looping shimmer and pulses. Clocks still tick: that's information, not animation."
      >
        <TokenTable
          head={["Token", "Value", "Use"]}
          rows={[
            [<Code key="1">--duration-instant</Code>, "80ms", "Press feedback"],
            [<Code key="2">--duration-fast</Code>, "140ms", "Hover, color, borders (Tailwind default transition)"],
            [<Code key="3">--duration-base</Code>, "200ms", "Menus, popovers, toasts, fades"],
            [<Code key="4">--duration-slow</Code>, "320ms", "Sheets, bar fills"],
            [<Code key="5">--easing-out</Code>, "cubic-bezier(.2,.8,.2,1)", "Default easing"],
          ]}
        />
      </Section>
    </>
  );
}
