import type { Connection, ConnectorInfo } from "@slai/shared";
import { createConnectionBody } from "@slai/shared";
import { Badge, Button, cn, EmptyState, Field, IconButton, Input, Skeleton, toast } from "@slai/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CircleAlert,
  ExternalLink,
  Eye,
  EyeOff,
  Lock,
  Search,
  Webhook,
} from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";
import { ErrorState } from "../../components/page";
import { api, errorMessage, isApiError } from "../../lib/api";
import { qk, useConnectors } from "../../lib/queries";
import { ProviderMark } from "./provider-mark";

const CAPABILITIES: { key: keyof ConnectorInfo["write"]; label: string }[] = [
  { key: "internalNote", label: "Internal notes" },
  { key: "publicReply", label: "Public replies" },
  { key: "assign", label: "Assign" },
  { key: "priority", label: "Priority" },
  { key: "tags", label: "Tags" },
];

export function CapabilityChips({ connector, className }: { connector: ConnectorInfo; className?: string }) {
  return (
    <ul className={cn("flex flex-wrap gap-1.5", className)} aria-label="Capabilities">
      {CAPABILITIES.map((c) => {
        const on = connector.write[c.key];
        return (
          <li key={c.key}>
            <Badge tone={on ? "neutral" : "outline"} size="sm" className={on ? undefined : "line-through opacity-70"}>
              {on && <Check aria-hidden />}
              <span className="sr-only">{on ? "Supports" : "Does not support"} </span>
              {c.label}
            </Badge>
          </li>
        );
      })}
      {connector.supportsWebhooks && (
        <li>
          <Badge tone="accent" size="sm" icon={<Webhook aria-hidden />}>
            Real-time webhooks
          </Badge>
        </li>
      )}
    </ul>
  );
}

export interface ConnectorCatalogProps {
  onSelect: (connector: ConnectorInfo) => void;
  className?: string;
}

/** A searchable grid of supported help desks. */
export function ConnectorCatalog({ onSelect, className }: ConnectorCatalogProps) {
  const query = useConnectors();
  const [filter, setFilter] = useState("");
  const list = useMemo(
    () => (query.data ?? []).filter((c) => c.displayName.toLowerCase().includes(filter.trim().toLowerCase())),
    [query.data, filter],
  );
  if (query.isPending) {
    return (
      <div className={cn("grid gap-2 sm:grid-cols-2", className)} role="status" aria-label="Loading help desks">
        {Array.from({ length: 6 }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
          <Skeleton key={i} className="h-[74px] rounded-lg" />
        ))}
      </div>
    );
  }
  if (query.isError)
    return <ErrorState compact error={query.error} resource="help desks" onRetry={() => query.refetch()} />;
  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <label htmlFor="connector-filter" className="sr-only">
        Filter help desks
      </label>
      <Input
        id="connector-filter"
        type="search"
        placeholder="Find your help desk"
        leading={<Search />}
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      {list.length === 0 ? (
        <EmptyState
          compact
          icon={<Search />}
          title="No help desk matches"
          description="Request a connector and we'll tell you when it ships."
        />
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2">
          {list.map((c) => (
            <li key={c.provider}>
              <button
                type="button"
                onClick={() => onSelect(c)}
                className="group flex w-full items-center gap-3 rounded-lg border border-line bg-surface p-3 text-left shadow-xs transition-[border-color,box-shadow] hover:border-line-strong hover:shadow-sm"
              >
                <ProviderMark provider={c.provider} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-ink">{c.displayName}</span>
                  <span className="block truncate text-xs text-ink-muted">
                    {c.authKind === "oauth2"
                      ? "Sign in with OAuth"
                      : c.authKind === "basic"
                        ? "Email + API token"
                        : "API token"}
                    {c.supportsWebhooks ? " · real-time" : " · polling"}
                  </span>
                </span>
                <ArrowRight
                  className="size-4 shrink-0 text-ink-subtle transition-transform group-hover:translate-x-0.5 group-hover:text-ink"
                  aria-hidden
                />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SecretInput({ id, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  const [shown, setShown] = useState(false);
  return (
    <Input
      id={id}
      type={shown ? "text" : "password"}
      autoComplete="off"
      spellCheck={false}
      {...props}
      trailing={
        <IconButton
          size="sm"
          label={shown ? "Hide value" : "Show value"}
          icon={shown ? <EyeOff /> : <Eye />}
          onClick={() => setShown((s) => !s)}
          className="-mr-1"
        />
      }
    />
  );
}

export interface ConnectFormProps {
  connector: ConnectorInfo;
  onConnected: (c: Connection) => void;
  onBack?: () => void;
}

type FieldErrors = Record<string, string>;

/** The credential form for one connector, generated from `ConnectorInfo.fields`. */
export function ConnectForm({ connector, onConnected, onBack }: ConnectFormProps) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(connector.displayName);
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<FieldErrors>({});
  const oauth = connector.authKind === "oauth2";

  const create = useMutation({
    mutationFn: api.connections.create,
    onSuccess: (conn) => {
      queryClient.invalidateQueries({ queryKey: qk.connections });
      queryClient.invalidateQueries({ queryKey: ["tickets"] });
      queryClient.invalidateQueries({ queryKey: qk.dashboard });
      queryClient.invalidateQueries({ queryKey: qk.customers });
      toast({ tone: "success", title: `${connector.displayName} connected`, description: "Syncing tickets now." });
      onConnected(conn);
    },
    onError: (e) => {
      if (isApiError(e) && Array.isArray(e.details)) {
        const next: FieldErrors = {};
        for (const issue of e.details as { path?: (string | number)[]; message?: string }[]) {
          const key = issue.path?.[issue.path.length - 1];
          if (typeof key === "string") next[key] = issue.message ?? "Invalid value";
        }
        setErrors(next);
      }
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next: FieldErrors = {};
    if (!name.trim()) next.__name = "Give this connection a name.";
    if (!oauth) {
      for (const f of connector.fields) {
        const optional = /optional/i.test(f.help ?? "");
        if (!optional && !values[f.key]?.trim()) next[f.key] = `${f.label} is required.`;
      }
    }
    setErrors(next);
    if (Object.keys(next).length) return;
    const credentials = Object.fromEntries(
      Object.entries(values)
        .map(([k, v]) => [k, v.trim()] as const)
        .filter(([, v]) => v),
    );
    const parsed = createConnectionBody.safeParse({
      provider: connector.provider,
      name: name.trim(),
      credentials,
      config: {},
    });
    if (!parsed.success) {
      setErrors({ __form: parsed.error.issues[0]?.message ?? "Check the form." });
      return;
    }
    create.mutate(parsed.data);
  };

  const serverError =
    create.error && !(isApiError(create.error) && Array.isArray(create.error.details))
      ? errorMessage(create.error)
      : null;

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-5">
      <div className="flex items-start gap-3">
        {onBack && (
          <IconButton label="Back to help desks" icon={<ArrowLeft />} size="sm" onClick={onBack} className="-ml-1.5" />
        )}
        <ProviderMark provider={connector.provider} size="lg" />
        <div className="min-w-0 flex-1">
          <h3 className="text-md font-semibold text-ink">Connect {connector.displayName}</h3>
          <a
            href={connector.docsUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-accent-text hover:underline"
          >
            API documentation <ExternalLink className="size-3" aria-hidden />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-xs font-medium text-ink-muted">What slai can do in {connector.displayName}</p>
        <CapabilityChips connector={connector} />
      </div>

      <Field label="Connection name" hint="Shown in slai only." error={errors.__name} required>
        <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
      </Field>

      {connector.fields.map((f) => (
        <Field
          key={f.key}
          label={f.label}
          hint={f.help}
          error={errors[f.key]}
          required={!oauth && !/optional/i.test(f.help ?? "")}
        >
          {f.secret ? (
            <SecretInput
              placeholder={f.placeholder}
              value={values[f.key] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
            />
          ) : (
            <Input
              placeholder={f.placeholder}
              value={values[f.key] ?? ""}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
            />
          )}
        </Field>
      ))}

      <p className="flex items-start gap-2 rounded-md border border-line bg-sunken/60 px-3 py-2 text-xs text-ink-muted">
        <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        Credentials are encrypted at rest (AES-256-GCM), never shown again, and never passed to AI agents.
      </p>

      {(serverError || errors.__form) && (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-md border border-breached-border bg-breached-subtle px-3 py-2 text-sm text-breached-text"
        >
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          {serverError ?? errors.__form}
        </p>
      )}

      <div className="flex items-center justify-end gap-2">
        {onBack && (
          <Button type="button" variant="ghost" onClick={onBack}>
            Back
          </Button>
        )}
        <Button type="submit" variant="primary" loading={create.isPending}>
          {oauth ? `Continue with ${connector.displayName}` : "Connect"}
        </Button>
      </div>
    </form>
  );
}

/** Catalog → credential form, in one component. */
export function ConnectHelpDesk({ onConnected }: { onConnected: (c: Connection) => void }) {
  const [selected, setSelected] = useState<ConnectorInfo | null>(null);
  return selected ? (
    <ConnectForm connector={selected} onConnected={onConnected} onBack={() => setSelected(null)} />
  ) : (
    <ConnectorCatalog onSelect={setSelected} />
  );
}
