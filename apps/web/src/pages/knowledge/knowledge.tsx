import type { KnowledgeArticle, KnowledgeSource, KnowledgeSourceStatus } from "@slai/shared";
import { savedReplyBody } from "@slai/shared";
import {
  Badge,
  type BadgeTone,
  Button,
  Card,
  CardHeader,
  Dialog,
  EmptyState,
  Field,
  formatNumber,
  formatRelative,
  IconButton,
  Input,
  Select,
  Skeleton,
  SkeletonRows,
  Switch,
  Table,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  TBody,
  TD,
  Textarea,
  TH,
  THead,
  Tooltip,
  TR,
  toast,
} from "@slai/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  BookOpen,
  CircleAlert,
  CircleCheck,
  ExternalLink,
  LibraryBig,
  Loader2,
  MessageSquareText,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { ErrorState, Page } from "../../components/page";
import { api, errorMessage, isApiError } from "../../lib/api";
import { eligibleConnections, SOURCE_KIND_LABEL, type SyncedKind, safeHref, urlHost } from "../../lib/knowledge";
import { providerLabel } from "../../lib/labels";
import { useConnections, useConnectors, useKnowledgeArticles, useKnowledgeSources, useMe } from "../../lib/queries";

const STATUS: Record<KnowledgeSourceStatus, { label: string; tone: BadgeTone; icon: React.ReactNode }> = {
  idle: { label: "Synced", tone: "ok", icon: <CircleCheck aria-hidden /> },
  syncing: { label: "Syncing", tone: "accent", icon: <Loader2 className="animate-spin" aria-hidden /> },
  error: { label: "Error", tone: "breached", icon: <CircleAlert aria-hidden /> },
};

function useInvalidateKnowledge() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ["knowledge"] });
}

function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function KnowledgePage() {
  const me = useMe();
  const canManage = me.data ? ["owner", "admin"].includes(me.data.role) : false;
  const sources = useKnowledgeSources();
  const [adding, setAdding] = useState(false);
  const [tab, setTab] = useState("articles");

  return (
    <Page
      title="Knowledge"
      description="Help-center articles and saved replies that drafts may quote. Drafts without relevant knowledge are flagged as unsure, and autopilot never sends them."
      actions={
        canManage && (
          <Button leadingIcon={<Plus />} onClick={() => setAdding(true)}>
            Add source
          </Button>
        )
      }
    >
      <section aria-labelledby="sources-heading" className="mb-6">
        <h2 id="sources-heading" className="sr-only">
          Sources
        </h2>
        {sources.isPending ? (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" role="status" aria-label="Loading sources">
            {[0, 1].map((i) => (
              <Skeleton key={i} className="h-44 rounded-lg" />
            ))}
          </div>
        ) : sources.isError ? (
          <Card>
            <ErrorState error={sources.error} resource="knowledge sources" onRetry={() => sources.refetch()} />
          </Card>
        ) : sources.data.items.length === 0 ? (
          <Card>
            <EmptyState
              icon={<LibraryBig />}
              title="No knowledge yet"
              description="Sync your help center's articles, or write saved replies below. Drafts cite them with links so customers get answers, not holding replies."
              action={
                canManage && (
                  <Button size="sm" variant="primary" leadingIcon={<Plus />} onClick={() => setAdding(true)}>
                    Add source
                  </Button>
                )
              }
            />
          </Card>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {sources.data.items.map((s) => (
              <SourceCard key={s.id} source={s} canManage={canManage} />
            ))}
          </div>
        )}
      </section>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList aria-label="Knowledge">
          <TabsTrigger value="articles">Articles</TabsTrigger>
          <TabsTrigger value="replies">Saved replies</TabsTrigger>
        </TabsList>
        <TabsContent value="articles" className="mt-4">
          <ArticlesPanel sources={sources.data?.items ?? []} canManage={canManage} />
        </TabsContent>
        <TabsContent value="replies" className="mt-4">
          <SavedRepliesPanel sources={sources.data?.items ?? []} canManage={canManage} />
        </TabsContent>
      </Tabs>

      {adding && <AddSourceDialog onClose={() => setAdding(false)} />}
    </Page>
  );
}

// ---------------------------------------------------------------- sources

function SourceCard({ source: s, canManage }: { source: KnowledgeSource; canManage: boolean }) {
  const connections = useConnections();
  const invalidate = useInvalidateKnowledge();
  const status = STATUS[s.status];
  const conn = connections.data?.items.find((c) => c.id === s.connectionId);
  const syncable = s.kind !== "manual";
  const sync = useMutation({
    mutationFn: () => api.knowledge.syncSource(s.id),
    onSuccess: () => {
      toast({
        tone: "info",
        title: "Sync started",
        description: `New and changed ${s.kind === "saved_replies" ? "saved replies" : "articles"} will appear shortly.`,
      });
      void invalidate();
    },
    onError: (e) => toast({ tone: "error", title: "Couldn't start a sync", description: errorMessage(e) }),
  });

  return (
    <Card className="flex flex-col">
      <div className="flex items-start gap-3 px-5 pt-5">
        <span className="grid size-9 shrink-0 place-items-center rounded-md border border-line bg-sunken text-ink-muted">
          {s.kind !== "helpdesk_articles" ? (
            <MessageSquareText className="size-4" aria-hidden />
          ) : (
            <BookOpen className="size-4" aria-hidden />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-md font-semibold text-ink">{s.name}</h3>
            {syncable && (
              <Badge tone={status.tone} size="sm" icon={status.icon}>
                {status.label}
              </Badge>
            )}
          </div>
          <p className="text-xs text-ink-muted">
            {SOURCE_KIND_LABEL[s.kind]}
            {conn ? ` · ${conn.name} (${providerLabel(conn.provider)})` : ""}
          </p>
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 px-5 py-4 text-sm">
        <div>
          <dt className="text-xs text-ink-muted">{s.kind === "helpdesk_articles" ? "Articles" : "Replies"}</dt>
          <dd className="font-mono text-ink tnum">
            {formatNumber(s.enabledCount)}
            <span className="text-ink-muted"> / {formatNumber(s.articleCount)} on</span>
          </dd>
        </div>
        <div>
          <dt className="text-xs text-ink-muted">{syncable ? "Last sync" : "Updated"}</dt>
          <dd className="text-ink">
            {syncable ? (
              s.lastSyncAt ? (
                <time dateTime={s.lastSyncAt}>{formatRelative(s.lastSyncAt)}</time>
              ) : (
                "Never"
              )
            ) : (
              "Edited in slai"
            )}
          </dd>
        </div>
      </dl>
      {s.status === "error" && s.lastError && (
        <div
          role="alert"
          className="mx-5 mb-4 flex items-start gap-2 rounded-md border border-breached-border bg-breached-subtle px-3 py-2 text-sm text-breached-text"
        >
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>{s.lastError}</span>
        </div>
      )}
      {syncable && canManage && (
        <div className="mt-auto flex items-center gap-2 border-t border-line px-5 py-3">
          <Button
            size="sm"
            leadingIcon={<RefreshCw />}
            loading={sync.isPending}
            disabled={s.status === "syncing"}
            onClick={() => sync.mutate()}
          >
            {s.status === "syncing" ? "Syncing…" : "Sync now"}
          </Button>
        </div>
      )}
    </Card>
  );
}

const SYNCED_KINDS: { kind: SyncedKind; label: string; suffix: string }[] = [
  { kind: "helpdesk_articles", label: "Help-center articles", suffix: "articles" },
  { kind: "saved_replies", label: "Saved replies and macros", suffix: "saved replies" },
];

function AddSourceDialog({ onClose }: { onClose: () => void }) {
  const connections = useConnections();
  const connectors = useConnectors();
  const sources = useKnowledgeSources();
  const invalidate = useInvalidateKnowledge();
  const [kindChoice, setKindChoice] = useState<SyncedKind | undefined>(undefined);
  const eligibleByKind = useMemo(() => {
    const args = [connectors.data ?? [], connections.data?.items ?? [], sources.data?.items ?? []] as const;
    return {
      helpdesk_articles: eligibleConnections("helpdesk_articles", ...args),
      saved_replies: eligibleConnections("saved_replies", ...args),
    };
  }, [connections.data, connectors.data, sources.data]);
  const kinds = SYNCED_KINDS.filter((k) => eligibleByKind[k.kind].length > 0);
  const kind = kinds.find((k) => k.kind === kindChoice) ?? kinds[0];
  const eligible = kind ? eligibleByKind[kind.kind] : [];
  const [connectionId, setConnectionId] = useState<string | undefined>(undefined);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const selected = eligible.find((c) => c.id === connectionId)?.id ?? eligible[0]?.id;
  const conn = eligible.find((c) => c.id === selected);
  const defaultName = `${conn?.name ?? "Help desk"} ${kind?.suffix ?? "articles"}`;

  const create = useMutation({
    mutationFn: () =>
      api.knowledge.createSource({
        kind: kind?.kind ?? "helpdesk_articles",
        name: name.trim() || defaultName,
        connectionId: selected ?? null,
      }),
    onSuccess: (s) => {
      toast({ tone: "success", title: `${s.name} added`, description: "The first sync has started." });
      void invalidate();
      onClose();
    },
    onError: (e) => {
      if (isApiError(e) && (e.isValidation || e.status === 409)) setError(e.message);
      else toast({ tone: "error", title: "Couldn't add the source", description: errorMessage(e) });
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    setError(null);
    create.mutate();
  };

  const loading = connections.isPending || connectors.isPending || sources.isPending;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Add a help-desk source"
      description="slai syncs a connected help desk's help-center articles or saved replies daily. You choose which ones drafts may use."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            type="submit"
            form="knowledge-source-form"
            loading={create.isPending}
            disabled={!selected}
          >
            Add and sync
          </Button>
        </>
      }
    >
      {loading ? (
        <SkeletonRows rows={2} label="Loading connections" />
      ) : eligible.length === 0 ? (
        <EmptyState
          compact
          icon={<BookOpen />}
          title="No help desk to add"
          description="Every connected help desk's help center and saved replies are already sources. You can also write saved replies on the Saved replies tab."
        />
      ) : (
        <form id="knowledge-source-form" onSubmit={submit} className="flex flex-col gap-4" noValidate>
          {error && (
            <p role="alert" className="rounded-md bg-breached-subtle px-3 py-2 text-sm text-breached-text">
              {error}
            </p>
          )}
          {kinds.length > 1 && (
            <Field label="What to sync">
              <Select
                value={kind?.kind}
                onValueChange={(v) => setKindChoice(v as SyncedKind)}
                options={kinds.map((k) => ({ value: k.kind, label: k.label }))}
                className="w-full"
              />
            </Field>
          )}
          <Field label="Help desk">
            <Select
              value={selected}
              onValueChange={setConnectionId}
              options={eligible.map((c) => ({ value: c.id, label: `${c.name} (${providerLabel(c.provider)})` }))}
              className="w-full"
            />
          </Field>
          <Field label="Name" hint="Optional. Shown on this page and in draft notes.">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={defaultName} maxLength={120} />
          </Field>
        </form>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------- articles

function ArticleTitle({ article: a }: { article: KnowledgeArticle }) {
  const href = safeHref(a.url);
  return (
    <>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 font-medium text-ink hover:text-accent-text hover:underline"
        >
          {a.title}
          <ExternalLink className="size-3 shrink-0 text-ink-subtle" aria-hidden />
          <span className="sr-only">(opens in a new tab)</span>
        </a>
      ) : (
        <span className="font-medium text-ink">{a.title}</span>
      )}
      <span className="mt-0.5 line-clamp-1 block text-xs text-ink-muted">
        {urlHost(href) ? `${urlHost(href)} · ` : ""}
        {a.bodyText}
      </span>
    </>
  );
}

function EnabledSwitch({ article: a, canManage }: { article: KnowledgeArticle; canManage: boolean }) {
  const invalidate = useInvalidateKnowledge();
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.knowledge.setEnabled(a.id, enabled),
    onSuccess: (x) => {
      toast({
        tone: "success",
        title: x.enabled ? "Drafts may use this article" : "Drafts won't use this article",
        description: x.title,
      });
      void invalidate();
    },
    onError: (e) => toast({ tone: "error", title: "Couldn't change the article", description: errorMessage(e) }),
  });
  const control = (
    <Switch
      checked={toggle.isPending ? (toggle.variables ?? a.enabled) : a.enabled}
      disabled={!canManage || toggle.isPending}
      onCheckedChange={(v) => toggle.mutate(v)}
      aria-label={`Use “${a.title}” in drafts`}
    />
  );
  return canManage ? control : <Tooltip content="Only admins can change this">{<span>{control}</span>}</Tooltip>;
}

function ArticlesPanel({ sources, canManage }: { sources: KnowledgeSource[]; canManage: boolean }) {
  const [q, setQ] = useState("");
  const [sourceId, setSourceId] = useState("all");
  const debounced = useDebounced(q.trim());
  const articles = useKnowledgeArticles({
    q: debounced || undefined,
    sourceId: sourceId === "all" ? undefined : sourceId,
    limit: 100,
  });
  const items = articles.data?.items ?? [];

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-4 pb-3">
        <h2 className="text-sm font-semibold text-ink">Articles drafts may use</h2>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <Select
            size="sm"
            aria-label="Filter by source"
            value={sourceId}
            onValueChange={setSourceId}
            options={[{ value: "all", label: "All sources" }, ...sources.map((s) => ({ value: s.id, label: s.name }))]}
            className="w-full sm:w-48"
          />
          <Input
            type="search"
            aria-label="Search articles"
            placeholder="Search title and body"
            leading={<Search />}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="w-full sm:w-64"
          />
        </div>
      </div>
      {articles.isPending ? (
        <div className="px-5 pb-5">
          <SkeletonRows rows={6} label="Loading articles" />
        </div>
      ) : articles.isError ? (
        <ErrorState error={articles.error} resource="articles" onRetry={() => articles.refetch()} />
      ) : items.length === 0 ? (
        debounced || sourceId !== "all" ? (
          <EmptyState
            compact
            icon={<Search />}
            title={debounced ? `No articles match “${debounced}”` : "No articles in this source"}
          />
        ) : (
          <EmptyState
            icon={<BookOpen />}
            title="No articles yet"
            description="Once a help-center source syncs, its articles appear here."
          />
        )
      ) : (
        <>
          <Table aria-label="Knowledge articles">
            <THead>
              <TR>
                <TH>Article</TH>
                <TH className="hidden md:table-cell">Source</TH>
                <TH className="hidden lg:table-cell">Updated</TH>
                <TH align="right">Use in drafts</TH>
              </TR>
            </THead>
            <TBody>
              {items.map((a) => (
                <TR key={a.id} className={a.enabled ? undefined : "opacity-70"}>
                  <TD className="max-w-md">
                    <ArticleTitle article={a} />
                  </TD>
                  <TD className="hidden md:table-cell">
                    <span className="text-xs text-ink-muted">{a.sourceName}</span>
                    {a.locale && (
                      <Badge tone="outline" size="sm" className="ml-2">
                        {a.locale}
                      </Badge>
                    )}
                  </TD>
                  <TD className="hidden lg:table-cell">
                    <time dateTime={a.updatedAt} className="text-xs text-ink-muted">
                      {formatRelative(a.updatedAt)}
                    </time>
                  </TD>
                  <TD align="right">
                    <EnabledSwitch article={a} canManage={canManage} />
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
          {articles.data?.nextCursor && (
            <p className="border-t border-line px-5 py-3 text-xs text-ink-muted">
              Showing the first {items.length} articles. Search to narrow the list.
            </p>
          )}
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- saved replies

function SavedRepliesPanel({ sources, canManage }: { sources: KnowledgeSource[]; canManage: boolean }) {
  const manual = sources.find((s) => s.kind === "manual");
  const replies = useKnowledgeArticles({ sourceId: manual?.id, limit: 200 }, Boolean(manual));
  const invalidate = useInvalidateKnowledge();
  const [editing, setEditing] = useState<KnowledgeArticle | "new" | null>(null);
  const [deleting, setDeleting] = useState<KnowledgeArticle | null>(null);
  const items = manual ? (replies.data?.items ?? []) : [];

  const remove = useMutation({
    mutationFn: (id: string) => api.knowledge.removeReply(id),
    onSuccess: () => {
      toast({ tone: "success", title: `“${deleting?.title ?? "Saved reply"}” deleted` });
      setDeleting(null);
      void invalidate();
    },
    onError: (e) => toast({ tone: "error", title: "Couldn't delete the saved reply", description: errorMessage(e) }),
  });

  const newButton = canManage && (
    <Button size="sm" variant="primary" leadingIcon={<Plus />} onClick={() => setEditing("new")}>
      New saved reply
    </Button>
  );

  return (
    <Card>
      <CardHeader
        title="Saved replies"
        description="Answers your team already trusts. Drafts can quote them like help-center articles. Saved replies synced from your help desk are listed under Articles."
        actions={items.length > 0 ? newButton : undefined}
      />
      {manual && replies.isPending ? (
        <div className="px-5 pb-5">
          <SkeletonRows rows={3} label="Loading saved replies" />
        </div>
      ) : manual && replies.isError ? (
        <ErrorState error={replies.error} resource="saved replies" onRetry={() => replies.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<MessageSquareText />}
          title="No saved replies"
          description="Write the answers you give most often, such as how to reset SSO or where to find invoices."
          action={newButton}
        />
      ) : (
        <ul className="border-t border-line">
          {items.map((r) => {
            const href = safeHref(r.url);
            return (
              <li key={r.id} className="flex items-start gap-4 border-b border-line px-5 py-4 last:border-b-0">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-medium text-ink">{r.title}</h3>
                    {!r.enabled && (
                      <Badge tone="neutral" size="sm">
                        Off
                      </Badge>
                    )}
                  </div>
                  <p className="mt-1 line-clamp-3 whitespace-pre-line text-sm text-ink-muted">{r.bodyText}</p>
                  <p className="mt-1 flex flex-wrap items-center gap-x-3 text-2xs text-ink-subtle">
                    {href && (
                      <a
                        href={href}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-accent-text hover:underline"
                      >
                        {urlHost(href)}
                        <ExternalLink className="size-3" aria-hidden />
                        <span className="sr-only">(opens in a new tab)</span>
                      </a>
                    )}
                    <span>
                      Edited <time dateTime={r.updatedAt}>{formatRelative(r.updatedAt)}</time>
                    </span>
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <EnabledSwitch article={r} canManage={canManage} />
                  {canManage && (
                    <>
                      <IconButton size="sm" label={`Edit ${r.title}`} icon={<Pencil />} onClick={() => setEditing(r)} />
                      <IconButton
                        size="sm"
                        label={`Delete ${r.title}`}
                        icon={<Trash2 />}
                        className="hover:text-breached-text"
                        onClick={() => setDeleting(r)}
                      />
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {editing !== null && (
        <SavedReplyDialog reply={editing === "new" ? null : editing} onClose={() => setEditing(null)} />
      )}
      <Dialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        size="sm"
        title={`Delete “${deleting?.title ?? "saved reply"}”?`}
        description="Drafts stop using it. Drafts that already cited it keep the title in their history."
        footer={
          <>
            <Button onClick={() => setDeleting(null)}>Cancel</Button>
            <Button variant="danger" loading={remove.isPending} onClick={() => deleting && remove.mutate(deleting.id)}>
              Delete saved reply
            </Button>
          </>
        }
      />
    </Card>
  );
}

type ReplyErrors = Partial<Record<"title" | "bodyText" | "url" | "form", string>>;

function SavedReplyDialog({ reply, onClose }: { reply: KnowledgeArticle | null; onClose: () => void }) {
  const invalidate = useInvalidateKnowledge();
  const [title, setTitle] = useState(reply?.title ?? "");
  const [bodyText, setBodyText] = useState(reply?.bodyText ?? "");
  const [url, setUrl] = useState(reply?.url ?? "");
  const [errors, setErrors] = useState<ReplyErrors>({});

  const save = useMutation({
    mutationFn: (body: ReturnType<typeof savedReplyBody.parse>) =>
      reply ? api.knowledge.updateReply(reply.id, body) : api.knowledge.createReply(body),
    onSuccess: (r) => {
      toast({ tone: "success", title: reply ? "Saved reply updated" : "Saved reply added", description: r.title });
      void invalidate();
      onClose();
    },
    onError: (e) => {
      if (isApiError(e) && e.isValidation) setErrors({ form: e.message });
      else toast({ tone: "error", title: "Couldn't save the reply", description: errorMessage(e) });
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = savedReplyBody.safeParse({ title, bodyText, url: url.trim() === "" ? null : url.trim() });
    if (!parsed.success) {
      const next: ReplyErrors = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] as keyof ReplyErrors;
        next[key] ??=
          key === "title"
            ? "Give the reply a short title."
            : key === "bodyText"
              ? "Write the reply (up to 10,000 characters)."
              : key === "url"
                ? "Enter a full http(s) link, or leave it empty."
                : issue.message;
      }
      setErrors(next);
      return;
    }
    setErrors({});
    save.mutate(parsed.data);
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title={reply ? "Edit saved reply" : "New saved reply"}
      description="Write it as facts a draft can rely on. Autopilot only sends links that appear in the ticket or in knowledge like this."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="saved-reply-form" loading={save.isPending}>
            {reply ? "Save changes" : "Add saved reply"}
          </Button>
        </>
      }
    >
      <form id="saved-reply-form" onSubmit={submit} className="flex flex-col gap-4" noValidate>
        {errors.form && (
          <p role="alert" className="rounded-md bg-breached-subtle px-3 py-2 text-sm text-breached-text">
            {errors.form}
          </p>
        )}
        <Field label="Title" required error={errors.title}>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
            maxLength={200}
            placeholder="Resetting SSO after a certificate rotation"
          />
        </Field>
        <Field label="Reply" required error={errors.bodyText} hint="Plain text. Keep it factual.">
          <Textarea
            value={bodyText}
            onChange={(e) => setBodyText(e.target.value)}
            rows={8}
            maxLength={10_000}
            placeholder="After you rotate your IdP signing certificate, upload the new certificate under Settings → Security → SSO…"
          />
        </Field>
        <Field label="Link" hint="Optional. A page drafts may link to." error={errors.url}>
          <Input
            type="url"
            inputMode="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://help.acme-cloud.example/sso/rotate-certificate"
          />
        </Field>
      </form>
    </Dialog>
  );
}
