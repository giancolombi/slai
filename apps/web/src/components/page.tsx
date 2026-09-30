import { Button, cn, EmptyState, PageHeader, type PageHeaderProps, SkeletonRows } from "@slai/ui";
import type { UseQueryResult } from "@tanstack/react-query";
import { CloudOff, Lock, SearchX } from "lucide-react";
import { type ReactNode, useEffect } from "react";
import { errorMessage, isApiError } from "../lib/api";

export interface PageProps extends Partial<PageHeaderProps> {
  children: ReactNode;
  /** Document title segment. Defaults to `title` when it's a string. */
  docTitle?: string;
  width?: "default" | "wide" | "narrow";
  className?: string;
}

/** Standard page frame: header + content with consistent gutters and max width. */
export function Page({
  title,
  description,
  actions,
  eyebrow,
  children,
  docTitle,
  width = "default",
  className,
}: PageProps) {
  const t = docTitle ?? (typeof title === "string" ? title : undefined);
  useEffect(() => {
    document.title = t ? `${t} · slai` : "slai";
  }, [t]);
  return (
    <div
      className={cn(
        "mx-auto w-full px-4 py-6 md:px-8 md:py-8",
        width === "wide" ? "max-w-[1440px]" : width === "narrow" ? "max-w-3xl" : "max-w-7xl",
        className,
      )}
    >
      {title && (
        <PageHeader title={title} description={description} actions={actions} eyebrow={eyebrow} className="mb-6" />
      )}
      {children}
    </div>
  );
}

export interface QueryStateProps<T> {
  query: UseQueryResult<T>;
  /** Render when data is present. */
  children: (data: T) => ReactNode;
  /** Custom loading placeholder. */
  loading?: ReactNode;
  /** Return true when `data` counts as empty. */
  isEmpty?: (data: T) => boolean;
  empty?: ReactNode;
  /** What failed, e.g. "tickets". */
  resource?: string;
}

/** One place for loading, error (with retry) and empty handling. */
export function QueryState<T>({
  query,
  children,
  loading,
  isEmpty,
  empty,
  resource = "this page",
}: QueryStateProps<T>) {
  if (query.isPending)
    return <>{loading ?? <SkeletonRows rows={6} className="py-2" label={`Loading ${resource}`} />}</>;
  if (query.isError) return <ErrorState error={query.error} resource={resource} onRetry={() => query.refetch()} />;
  if (isEmpty?.(query.data)) return <>{empty ?? <EmptyState icon={<SearchX />} title="Nothing here yet" />}</>;
  return <>{children(query.data)}</>;
}

export function ErrorState({
  error,
  resource = "this page",
  onRetry,
  compact,
}: {
  error: unknown;
  resource?: string;
  onRetry?: () => void;
  compact?: boolean;
}) {
  const forbidden = isApiError(error) && error.isForbidden;
  const network = isApiError(error) && error.isNetwork;
  return (
    <EmptyState
      tone="error"
      compact={compact}
      icon={forbidden ? <Lock /> : <CloudOff />}
      title={forbidden ? "You don't have access" : network ? "Can't reach slai" : `Couldn't load ${resource}`}
      description={forbidden ? "Ask an admin in your organization for access." : errorMessage(error)}
      action={
        onRetry && !forbidden ? (
          <Button size="sm" onClick={onRetry}>
            Try again
          </Button>
        ) : undefined
      }
    />
  );
}
