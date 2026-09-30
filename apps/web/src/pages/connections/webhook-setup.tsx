import type { WebhookSecretReveal } from "@slai/shared";
import { Badge, Button, Card, CardHeader, Field, IconButton, Input, toast } from "@slai/ui";
import { useMutation } from "@tanstack/react-query";
import { CircleCheck, Copy, Eye, KeyRound, ShieldCheck, Webhook } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../../lib/api";
import { copyText } from "./connections";

/** A step with `{url}` and `{secret}` filled in, as copyable code. */
function fill(step: string, reveal: WebhookSecretReveal): ReactNode[] {
  return step.split(/(\{url\}|\{secret\})/).map((part, i) => {
    const value = part === "{url}" ? reveal.webhookUrl : part === "{secret}" ? reveal.secret : null;
    if (value === null) return part === "{secret}" ? "(the secret below)" : part;
    return (
      // biome-ignore lint/suspicious/noArrayIndexKey: static split of one string
      <code key={i} className="break-all rounded-xs bg-sunken px-1 font-mono text-2xs text-ink">
        {value}
      </code>
    );
  });
}

function CopyRow({ label, value, what }: { label: string; value: string; what: string }) {
  return (
    <div>
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className="mt-1 flex items-center gap-1">
        <code className="min-w-0 flex-1 truncate rounded-sm border border-line bg-sunken px-2 py-1 font-mono text-2xs text-ink">
          {value}
        </code>
        <IconButton
          size="sm"
          label={`Copy ${what.toLowerCase()}`}
          icon={<Copy />}
          onClick={() => copyText(value, what)}
        />
      </dd>
    </div>
  );
}

/** The revealed URL, secret and provider steps (pure: renders what the API returned). */
export function WebhookInstructions({
  reveal,
  onSetSecret,
  settingSecret,
}: {
  reveal: WebhookSecretReveal;
  onSetSecret?: (secret: string) => void;
  settingSecret?: boolean;
}) {
  const [pasted, setPasted] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (pasted.trim().length >= 8) onSetSecret?.(pasted.trim());
  };
  return (
    <div className="flex flex-col gap-4">
      <dl className="flex flex-col gap-3">
        <CopyRow label="Webhook URL" value={reveal.webhookUrl} what="Webhook URL" />
        {reveal.secretSource === "slai" && reveal.secret && (
          <CopyRow label="Webhook secret" value={reveal.secret} what="Webhook secret" />
        )}
      </dl>
      {reveal.steps.length > 0 && (
        <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm text-ink" aria-label="Setup steps">
          {reveal.steps.map((s) => (
            <li key={s}>{fill(s, reveal)}</li>
          ))}
        </ol>
      )}
      {reveal.secretSource === "provider" && (
        <form onSubmit={submit} className="flex flex-col gap-2">
          <Field
            label="Signing secret from your help desk"
            hint={
              reveal.configured
                ? "A secret is saved. Paste a new one to replace it."
                : "Webhooks are rejected until this is saved."
            }
          >
            <Input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
            />
          </Field>
          <div className="flex items-center gap-2">
            <Button type="submit" size="sm" loading={settingSecret} disabled={pasted.trim().length < 8}>
              Save secret
            </Button>
            {reveal.configured && (
              <Badge tone="ok" size="sm" icon={<CircleCheck aria-hidden />}>
                Saved
              </Badge>
            )}
          </div>
        </form>
      )}
    </div>
  );
}

export interface WebhookSetupProps {
  connectionId: string;
  webhookUrl: string;
  canReveal: boolean;
  /** Reveal right away (just after connecting). */
  autoReveal?: boolean;
}

/** Webhook URL, plus the admin-only, audited reveal of the secret and setup steps. */
export function WebhookSetup({ connectionId, webhookUrl, canReveal, autoReveal }: WebhookSetupProps) {
  const reveal = useMutation({
    mutationFn: () => api.connections.revealWebhookSecret(connectionId),
    onError: (e) => toast({ tone: "error", title: "Couldn't reveal the webhook secret", description: errorMessage(e) }),
  });
  const setSecret = useMutation({
    mutationFn: (secret: string) => api.connections.setWebhookSecret(connectionId, secret),
    onSuccess: () => {
      toast({ tone: "success", title: "Signing secret saved" });
      reveal.mutate();
    },
    onError: (e) => toast({ tone: "error", title: "Couldn't save the secret", description: errorMessage(e) }),
  });
  const auto = useRef(false);
  useEffect(() => {
    if (autoReveal && canReveal && !auto.current) {
      auto.current = true;
      reveal.mutate();
    }
  }, [autoReveal, canReveal, reveal]);

  return (
    <Card>
      <CardHeader
        title={
          <span className="inline-flex items-center gap-1.5">
            <Webhook className="size-4" aria-hidden /> Real-time webhooks
          </span>
        }
        description="Point your help desk at slai so ticket changes arrive in seconds. slai also polls as a safety net."
      />
      <div className="px-5 pb-5">
        {reveal.data ? (
          <WebhookInstructions
            reveal={reveal.data}
            onSetSecret={(s) => setSecret.mutate(s)}
            settingSecret={setSecret.isPending}
          />
        ) : (
          <div className="flex flex-col gap-3">
            <dl>
              <CopyRow label="Webhook URL" value={webhookUrl} what="Webhook URL" />
            </dl>
            {canReveal ? (
              <div className="flex flex-wrap items-center gap-3">
                <Button size="sm" leadingIcon={<Eye />} loading={reveal.isPending} onClick={() => reveal.mutate()}>
                  Show secret and setup steps
                </Button>
                <span className="inline-flex items-center gap-1 text-xs text-ink-muted">
                  <ShieldCheck className="size-3.5" aria-hidden /> Recorded in the audit log.
                </span>
              </div>
            ) : (
              <p className="inline-flex items-center gap-1.5 text-xs text-ink-muted">
                <KeyRound className="size-3.5" aria-hidden /> Ask an admin to reveal the webhook secret and setup steps.
              </p>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
