import { Button, Logo, ThemeToggle } from "@slai/ui";
import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useEffect, useState } from "react";
import { Foundations } from "./foundations";
import { Gallery } from "./gallery";

const NAV: [string, [string, string][]][] = [
  [
    "Foundations",
    [
      ["principles", "Principles"],
      ["color", "Color"],
      ["risk", "Risk colors"],
      ["type", "Typography"],
      ["space", "Space & elevation"],
      ["motion", "Motion"],
    ],
  ],
  [
    "Components",
    [
      ["buttons", "Buttons"],
      ["forms", "Form controls"],
      ["status", "Badges & risk"],
      ["signature", "Signature"],
      ["data", "Data display"],
      ["overlays", "Overlays"],
      ["states", "States"],
      ["shell", "App shell"],
    ],
  ],
  [
    "Guides",
    [
      ["format", "Formatting"],
      ["usage", "Using the system"],
    ],
  ],
];

function useActiveSection(ids: string[]) {
  const [active, setActive] = useState(ids[0]);
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: "-80px 0px -65% 0px" },
    );
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [ids]);
  return active;
}

const IDS = NAV.flatMap(([, items]) => items.map(([id]) => id));

/** The living style guide: tokens, components and usage, rendered by the real components. */
export function DesignPage() {
  const active = useActiveSection(IDS);
  useEffect(() => {
    document.title = "Design system · slai";
  }, []);
  return (
    <div className="min-h-dvh bg-canvas">
      <header className="sticky top-0 z-[var(--z-sticky)] border-b border-line bg-canvas/85 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-[1320px] items-center gap-3 px-4 md:px-8">
          <Link to="/" aria-label="slai home">
            <Logo />
          </Link>
          <span className="text-ink-subtle" aria-hidden>
            /
          </span>
          <span className="text-sm font-medium text-ink">Design system</span>
          <div className="ml-auto flex items-center gap-2">
            <Button asChild size="sm" variant="ghost">
              <Link to="/">
                <ArrowLeft aria-hidden /> Back to app
              </Link>
            </Button>
            <ThemeToggle />
          </div>
        </div>
      </header>
      <div className="mx-auto flex max-w-[1320px] gap-10 px-4 md:px-8">
        <nav
          aria-label="Style guide sections"
          className="sticky top-14 hidden h-[calc(100dvh-56px)] w-48 shrink-0 overflow-y-auto py-10 lg:block"
        >
          {NAV.map(([group, items]) => (
            <div key={group} className="mb-6">
              <p className="mb-2 text-2xs font-semibold tracking-wider text-ink-subtle uppercase">{group}</p>
              <ul className="flex flex-col gap-px border-l border-line">
                {items.map(([id, label]) => (
                  <li key={id}>
                    <a
                      href={`#${id}`}
                      aria-current={active === id ? "location" : undefined}
                      className="-ml-px block border-l-2 border-transparent py-1 pl-3 text-sm text-ink-muted hover:text-ink aria-[current=location]:border-accent aria-[current=location]:font-medium aria-[current=location]:text-ink"
                    >
                      {label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <main id="main" className="min-w-0 flex-1 py-10">
          <div className="mb-12 max-w-3xl">
            <p className="text-xs font-semibold tracking-wider text-accent-text uppercase">@slai/ui</p>
            <h1 className="mt-2 text-4xl font-semibold tracking-tight text-ink">The slai design system</h1>
            <p className="mt-3 text-md text-ink-muted">
              Tokens, components and patterns for a product where time is the material and a contract is on the line.
              This page is the documentation: everything here is rendered by the real components, in both themes.
            </p>
          </div>
          <div className="flex flex-col gap-10">
            <Foundations />
            <Gallery />
          </div>
        </main>
      </div>
    </div>
  );
}
