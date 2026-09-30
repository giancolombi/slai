import { Button, Card, EmptyState } from "@slai/ui";
import { getRouteApi, Link, useLocation } from "@tanstack/react-router";
import { ArrowLeft, BookOpen, SearchX } from "lucide-react";
import { useEffect } from "react";
import { Page } from "../../components/page";
import { getGuide } from "../../help/guides";

const route = getRouteApi("/_app/help/$guideId");

function BackToHelp() {
  return (
    <Button asChild variant="ghost" size="sm" className="-ml-2">
      <Link to="/help">
        <ArrowLeft aria-hidden /> Help
      </Link>
    </Button>
  );
}

export function GuidePage() {
  const { guideId } = route.useParams();
  const hash = useLocation({ select: (l) => l.hash });
  const guide = getGuide(guideId);

  // Jump to a section or FAQ entry named in the URL (search results and cross-links use anchors).
  // biome-ignore lint/correctness/useExhaustiveDependencies: the same anchor in another guide must scroll again
  useEffect(() => {
    if (!hash) return;
    const el = document.getElementById(hash);
    if (el) el.scrollIntoView({ block: "start" });
  }, [hash, guideId]);

  if (!guide) {
    return (
      <Page docTitle="Help">
        <div className="mb-4">
          <BackToHelp />
        </div>
        <Card>
          <EmptyState
            icon={<SearchX />}
            title="This guide doesn't exist"
            description="It may have moved. Search the Help center instead."
            action={
              <Button asChild variant="primary" size="sm">
                <Link to="/help">Open Help</Link>
              </Button>
            }
          />
        </Card>
      </Page>
    );
  }

  const { Body } = guide;
  return (
    <Page title={guide.title} description={guide.summary} eyebrow={<BackToHelp />} docTitle={`${guide.title} · Help`}>
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_14rem]">
        <article aria-label={guide.title} className="min-w-0 max-w-3xl">
          <Body />
        </article>
        <aside className="flex flex-col gap-6 lg:sticky lg:top-20 lg:self-start">
          {guide.sections.length > 1 && (
            <nav aria-label="On this page">
              <p className="mb-1.5 text-2xs font-semibold tracking-wider text-ink-subtle uppercase">On this page</p>
              <ul className="flex flex-col gap-1 border-l border-line">
                {guide.sections.map((s) => (
                  <li key={s.id}>
                    <Link
                      to="/help/$guideId"
                      params={{ guideId: guide.id }}
                      hash={s.id}
                      className="-ml-px block border-l border-transparent py-0.5 pl-3 text-xs text-ink-muted hover:border-line-strong hover:text-ink"
                    >
                      {s.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          )}
          <nav aria-label="Related guides">
            <p className="mb-1.5 text-2xs font-semibold tracking-wider text-ink-subtle uppercase">Related</p>
            <ul className="flex flex-col gap-1">
              {guide.related.map((id) => (
                <li key={id}>
                  <Link
                    to="/help/$guideId"
                    params={{ guideId: id }}
                    className="flex items-center gap-2 rounded-sm py-0.5 text-sm text-accent-text hover:underline"
                  >
                    <BookOpen className="size-3.5 shrink-0" aria-hidden />
                    {getGuide(id)?.title}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </aside>
      </div>
    </Page>
  );
}
