import { Button, Sheet } from "@slai/ui";
import { Link, useMatches } from "@tanstack/react-router";
import { ArrowRight, BookOpen, CircleHelp, Info } from "lucide-react";
import { useState } from "react";
import { PAGE_HELP, type PageHelp } from "./page-help";
import { GUIDE_TITLES } from "./titles";

/** The help entry for the page being shown (the deepest matched route), if any. */
export function usePageHelp(): PageHelp | null {
  const matches = useMatches();
  const path = (matches[matches.length - 1] as { fullPath?: string } | undefined)?.fullPath;
  return (path && PAGE_HELP[path]) || null;
}

/** The body of the "About this page" panel. */
export function PageHelpContent({ help, onNavigate }: { help: PageHelp; onNavigate?: () => void }) {
  return (
    <div className="flex flex-col gap-5">
      <section aria-labelledby="page-help-what">
        <h3 id="page-help-what" className="mb-1 text-xs font-semibold tracking-wide text-ink-subtle uppercase">
          What this page is for
        </h3>
        <p className="text-sm leading-relaxed text-ink">{help.purpose}</p>
      </section>
      <section aria-labelledby="page-help-next">
        <h3 id="page-help-next" className="mb-1.5 text-xs font-semibold tracking-wide text-ink-subtle uppercase">
          What to do next
        </h3>
        <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm leading-relaxed text-ink-muted marker:text-ink-subtle">
          {help.next.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      </section>
      <section aria-labelledby="page-help-guides">
        <h3 id="page-help-guides" className="mb-1.5 text-xs font-semibold tracking-wide text-ink-subtle uppercase">
          Guides
        </h3>
        <ul className="flex flex-col gap-1">
          {help.guides.map((g) => (
            <li key={g}>
              <Link
                to="/help/$guideId"
                params={{ guideId: g }}
                onClick={onNavigate}
                className="group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-ink hover:bg-hover"
              >
                <BookOpen className="size-4 text-ink-subtle" aria-hidden />
                {GUIDE_TITLES[g]}
                <ArrowRight className="ml-auto size-3.5 text-ink-subtle group-hover:text-ink" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/**
 * "About this page": a button in the top bar that opens a side sheet (a modal dialog:
 * focus moves in, is trapped, and returns to the button on close).
 */
export function PageHelpButton() {
  const help = usePageHelp();
  const [open, setOpen] = useState(false);
  if (!help) return null;
  const close = () => setOpen(false);
  return (
    <Sheet
      open={open}
      onOpenChange={setOpen}
      title={`About this page: ${help.title}`}
      trigger={
        <Button
          variant="ghost"
          size="sm"
          leadingIcon={<Info aria-hidden />}
          aria-label={`About this page: ${help.title}`}
        >
          <span className="hidden xl:inline">About this page</span>
        </Button>
      }
      footer={
        <Button asChild variant="secondary" size="sm" leadingIcon={<CircleHelp aria-hidden />}>
          <Link to="/help" onClick={close}>
            Open the Help center
          </Link>
        </Button>
      }
    >
      <PageHelpContent help={help} onNavigate={close} />
    </Sheet>
  );
}
