import { cn } from "@slai/ui";
import { providerLabel } from "../../lib/labels";

/** A neutral lettered tile per help desk (no third-party logos). Hue is stable per provider. */
const HUES: Record<string, number> = {
  zendesk: 160,
  jira_sm: 250,
  intercom: 220,
  freshdesk: 145,
  hubspot: 30,
  zammad: 200,
  help_scout: 265,
  demo: 290,
};

export function ProviderMark({ provider, size = "md" }: { provider: string; size?: "sm" | "md" | "lg" }) {
  const label = providerLabel(provider);
  const hue = HUES[provider] ?? 240;
  const letters = label
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-md border font-semibold tracking-tight",
        size === "sm" ? "size-6 text-2xs" : size === "lg" ? "size-10 text-sm" : "size-9 text-xs",
      )}
      style={{
        background: `color-mix(in oklab, oklch(0.7 0.1 ${hue}) 18%, var(--surface))`,
        borderColor: `color-mix(in oklab, oklch(0.6 0.1 ${hue}) 30%, var(--line))`,
        color: `color-mix(in oklab, oklch(0.55 0.13 ${hue}) 60%, var(--text))`,
      }}
    >
      {letters}
    </span>
  );
}
