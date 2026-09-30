import { Button, Card, EmptyState, Input, Kbd, Skeleton } from "@slai/ui";
import { Link } from "@tanstack/react-router";
import { ArrowRight, BookOpen, ListChecks, Search, SearchX } from "lucide-react";
import { type KeyboardEvent, useId, useMemo, useRef, useState } from "react";
import { ErrorState, Page } from "../../components/page";
import { Checklist } from "../../help/checklist";
import { GUIDE_GROUPS, getGuide, type SearchResult, searchHelp } from "../../help/guides";
import { useMe, useOnboarding, useUpdateOnboarding } from "../../lib/queries";

/** Arrow keys move between the search box and its results; Escape clears. */
function useListKeys(
  inputRef: React.RefObject<HTMLInputElement | null>,
  listRef: React.RefObject<HTMLUListElement | null>,
) {
  const links = () => Array.from(listRef.current?.querySelectorAll<HTMLAnchorElement>("a[data-result]") ?? []);
  const onInputKey = (e: KeyboardEvent<HTMLInputElement>, clear: () => void) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      links()[0]?.focus();
    } else if (e.key === "Enter") {
      const first = links()[0];
      if (first) {
        e.preventDefault();
        first.click();
      }
    } else if (e.key === "Escape") {
      clear();
    }
  };
  const onListKey = (e: KeyboardEvent<HTMLUListElement>) => {
    const all = links();
    const i = all.indexOf(document.activeElement as HTMLAnchorElement);
    if (i < 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      all[Math.min(i + 1, all.length - 1)]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (i === 0) inputRef.current?.focus();
      else all[i - 1]?.focus();
    } else if (e.key === "Escape") {
      inputRef.current?.focus();
    }
  };
  return { onInputKey, onListKey };
}

function Results({
  results,
  query,
  listRef,
  onKeyDown,
  id,
}: {
  results: SearchResult[];
  query: string;
  listRef: React.RefObject<HTMLUListElement | null>;
  onKeyDown: (e: KeyboardEvent<HTMLUListElement>) => void;
  id: string;
}) {
  if (results.length === 0) {
    return (
      <Card>
        <EmptyState
          compact
          icon={<SearchX />}
          title={`Nothing matches “${query}”`}
          description="Try another word, such as “pause”, “autopilot” or “credits”, or browse the guides below."
        />
      </Card>
    );
  }
  return (
    <Card>
      <ul id={id} ref={listRef} onKeyDown={onKeyDown} aria-label="Search results" className="flex flex-col">
        {results.map((r) => (
          <li key={`${r.guide}#${r.anchor ?? ""}`} className="border-b border-line last:border-b-0">
            <Link
              data-result
              to="/help/$guideId"
              params={{ guideId: r.guide }}
              hash={r.anchor}
              className="flex items-start gap-3 px-5 py-3 transition-colors hover:bg-hover focus-visible:bg-hover focus-visible:-outline-offset-2"
            >
              <BookOpen className="mt-0.5 size-4 shrink-0 text-ink-subtle" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-ink">{r.title}</span>
                <span className="block text-xs text-ink-muted">
                  {r.context}
                  {r.snippet ? ` · ${r.snippet}` : ""}
                </span>
              </span>
              <ArrowRight className="mt-0.5 size-3.5 shrink-0 text-ink-subtle" aria-hidden />
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function ChecklistSection() {
  const me = useMe();
  const onboarding = useOnboarding();
  const update = useUpdateOnboarding();
  const canAct = me.data?.role === "owner" || me.data?.role === "admin";
  if (onboarding.isPending) return <Skeleton className="h-40 rounded-lg" />;
  if (onboarding.isError)
    return (
      <Card>
        <ErrorState compact error={onboarding.error} resource="the checklist" onRetry={() => onboarding.refetch()} />
      </Card>
    );
  const s = onboarding.data;
  return (
    <section aria-labelledby="setup-title" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="setup-title" className="flex items-center gap-2 text-md font-semibold text-ink">
          <ListChecks className="size-4 text-ink-muted" aria-hidden /> Setup checklist
        </h2>
        {s.checklistDismissed && (
          <Button
            size="sm"
            variant="secondary"
            loading={update.isPending}
            onClick={() => update.mutate({ checklistDismissed: false })}
          >
            Show it on the dashboard
          </Button>
        )}
      </div>
      <Checklist state={s} canAct={canAct} />
    </section>
  );
}

export function HelpCenterPage() {
  const [query, setQuery] = useState("");
  const results = useMemo(() => searchHelp(query), [query]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const resultsId = useId();
  const { onInputKey, onListKey } = useListKeys(inputRef, listRef);
  const searching = query.trim().length > 0;

  return (
    <Page
      title="Help"
      description="Short guides to every part of slai, written for support leaders. Press ? anywhere to come back here."
    >
      <search className="mb-6 max-w-xl">
        <label htmlFor="help-search" className="sr-only">
          Search help
        </label>
        <Input
          ref={inputRef}
          id="help-search"
          type="search"
          autoComplete="off"
          placeholder="Search help: pause, autopilot, credits…"
          leading={<Search />}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => onInputKey(e, () => setQuery(""))}
          aria-controls={searching ? resultsId : undefined}
          aria-describedby="help-search-hint"
        />
        <p id="help-search-hint" className="mt-1.5 text-xs text-ink-subtle">
          <Kbd>↓</Kbd> to move through results, <Kbd>Enter</Kbd> to open the first.
        </p>
        <p className="sr-only" aria-live="polite">
          {searching ? `${results.length} ${results.length === 1 ? "result" : "results"}` : ""}
        </p>
      </search>

      {searching ? (
        <Results results={results} query={query.trim()} listRef={listRef} onKeyDown={onListKey} id={resultsId} />
      ) : (
        <div className="flex flex-col gap-8">
          <ChecklistSection />
          {GUIDE_GROUPS.map((group) => (
            <section key={group.title} aria-labelledby={`group-${group.title}`} className="flex flex-col gap-3">
              <h2 id={`group-${group.title}`} className="text-md font-semibold text-ink">
                {group.title}
              </h2>
              <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
                {group.ids.map((id) => {
                  const g = getGuide(id)!;
                  return (
                    <li key={id}>
                      <Link to="/help/$guideId" params={{ guideId: id }} className="group block h-full rounded-lg">
                        <Card interactive className="flex h-full flex-col gap-1 p-4">
                          <span className="flex items-center gap-2 text-sm font-semibold text-ink">
                            <BookOpen className="size-4 text-accent-text" aria-hidden />
                            {g.title}
                          </span>
                          <span className="text-sm text-ink-muted">{g.summary}</span>
                        </Card>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </Page>
  );
}
