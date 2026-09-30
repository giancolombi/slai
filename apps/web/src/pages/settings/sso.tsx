import { createSsoProviderBody, type SsoProtocol, type SsoProvider } from "@slai/shared";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  Dialog,
  EmptyState,
  Field,
  IconButton,
  Input,
  SegmentedControl,
  Skeleton,
  Switch,
  Textarea,
  toast,
} from "@slai/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Building2, Check, Copy, RefreshCw, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { ErrorState } from "../../components/page";
import { api, errorMessage } from "../../lib/api";
import { qk, useOrgSso } from "../../lib/queries";
import { apiFieldErrors, type FieldErrors, zodFieldErrors } from "../auth/form-errors";

function CopyValue({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <code className="min-w-0 truncate rounded-sm bg-sunken px-1.5 py-0.5 font-mono text-xs text-ink" title={value}>
        {value}
      </code>
      <IconButton
        size="sm"
        label={copied ? "Copied" : `Copy ${label}`}
        icon={copied ? <Check className="text-ok-text" /> : <Copy />}
        onClick={async () => {
          await navigator.clipboard.writeText(value).catch(() => {});
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      />
    </div>
  );
}

function AddProviderDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const queryClient = useQueryClient();
  const [protocol, setProtocol] = useState<SsoProtocol>("oidc");
  const [v, setV] = useState({
    name: "",
    domains: "",
    issuer: "",
    clientId: "",
    clientSecret: "",
    metadataUrl: "",
    metadataXml: "",
  });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setV((x) => ({ ...x, [k]: e.target.value }));

  const create = useMutation({
    mutationFn: api.sso.create,
    onSuccess: (p) => {
      void queryClient.invalidateQueries({ queryKey: qk.sso });
      toast({ tone: "success", title: `${p.name} added`, description: "Now verify your domain to turn it on." });
      onOpenChange(false);
      setV({ name: "", domains: "", issuer: "", clientId: "", clientSecret: "", metadataUrl: "", metadataXml: "" });
    },
    onError: (e) => {
      const fields = apiFieldErrors(e);
      if (Object.keys(fields).length) setErrors(fields);
      else setFormError(errorMessage(e));
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const domains = v.domains
      .split(/[\s,]+/)
      .map((d) => d.trim())
      .filter(Boolean);
    const body =
      protocol === "oidc"
        ? {
            protocol,
            name: v.name,
            domains,
            issuer: v.issuer.trim(),
            clientId: v.clientId,
            clientSecret: v.clientSecret,
          }
        : {
            protocol,
            name: v.name,
            domains,
            ...(v.metadataUrl.trim() ? { metadataUrl: v.metadataUrl.trim() } : { metadataXml: v.metadataXml }),
          };
    const parsed = createSsoProviderBody.safeParse(body);
    if (!parsed.success) {
      const fe = zodFieldErrors(parsed.error);
      setErrors({
        ...fe,
        ...(fe._form && protocol === "saml" && { metadataUrl: "Give a metadata URL or paste the metadata XML." }),
      });
      return;
    }
    setErrors({});
    create.mutate(parsed.data);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add an SSO provider"
      description="People with an email on your verified domains sign in through this identity provider."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" loading={create.isPending} onClick={submit}>
            Add provider
          </Button>
        </>
      }
    >
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        {formError && <p className="text-sm text-breached-text">{formError}</p>}
        <SegmentedControl
          aria-label="Protocol"
          value={protocol}
          onValueChange={(p) => setProtocol(p as SsoProtocol)}
          options={[
            { value: "oidc", label: "OpenID Connect" },
            { value: "saml", label: "SAML 2.0" },
          ]}
        />
        <Field label="Name" error={errors.name}>
          <Input value={v.name} onChange={set("name")} placeholder="Okta" autoFocus />
        </Field>
        <Field label="Email domains" hint="Comma-separated, e.g. acme.com, acme.co.uk" error={errors.domains}>
          <Input value={v.domains} onChange={set("domains")} placeholder="acme.com" />
        </Field>
        {protocol === "oidc" ? (
          <>
            <Field label="Issuer URL" hint="We read its OpenID configuration." error={errors.issuer}>
              <Input value={v.issuer} onChange={set("issuer")} placeholder="https://acme.okta.com" />
            </Field>
            <Field label="Client ID" error={errors.clientId}>
              <Input value={v.clientId} onChange={set("clientId")} />
            </Field>
            <Field label="Client secret" hint="Stored encrypted. It is never shown again." error={errors.clientSecret}>
              <Input type="password" autoComplete="off" value={v.clientSecret} onChange={set("clientSecret")} />
            </Field>
          </>
        ) : (
          <>
            <Field label="Metadata URL" error={errors.metadataUrl}>
              <Input value={v.metadataUrl} onChange={set("metadataUrl")} placeholder="https://idp.acme.com/metadata" />
            </Field>
            <Field label="…or metadata XML" error={errors.metadataXml}>
              <Textarea rows={4} value={v.metadataXml} onChange={set("metadataXml")} className="font-mono text-xs" />
            </Field>
          </>
        )}
      </form>
    </Dialog>
  );
}

function ProviderRow({ p }: { p: SsoProvider }) {
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: qk.sso });
  const verify = useMutation({
    mutationFn: () => api.sso.verifyDomain(p.id),
    onSuccess: () => {
      void refresh();
      toast({
        tone: "success",
        title: "Domain verified",
        description: `${p.domains.join(", ")} now signs in with SSO.`,
      });
    },
    onError: (e) => toast({ tone: "error", title: "Not verified yet", description: errorMessage(e) }),
  });
  const remove = useMutation({
    mutationFn: () => api.sso.remove(p.id),
    onSuccess: () => {
      setConfirm(false);
      void refresh();
      toast({ tone: "success", title: `${p.name} removed` });
    },
    onError: (e) => toast({ tone: "error", title: "Couldn't remove", description: errorMessage(e) }),
  });
  return (
    <li className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <Building2 className="mt-0.5 size-4 text-ink-muted" aria-hidden />
          <div>
            <p className="flex items-center gap-2 text-sm font-medium text-ink">
              {p.name}
              <Badge tone="outline" size="sm">
                {p.protocol === "oidc" ? "OIDC" : "SAML"}
              </Badge>
              <Badge tone={p.domainVerified ? "ok" : "warning"} size="sm">
                {p.domainVerified ? "Verified" : "Domain not verified"}
              </Badge>
            </p>
            <p className="text-xs text-ink-muted">
              {p.domains.join(", ")} · {p.issuer}
              {p.clientId ? ` · client ${p.clientId}` : ""}
            </p>
          </div>
        </div>
        <Button variant="ghost" size="sm" leadingIcon={<Trash2 />} onClick={() => setConfirm(true)}>
          Remove
        </Button>
      </div>
      <div className="grid gap-2 rounded-md border border-line bg-sunken/50 p-3 text-xs">
        <div className="grid grid-cols-[9rem_1fr] items-center gap-2">
          <span className="text-ink-muted">{p.protocol === "oidc" ? "Redirect URI" : "ACS URL"}</span>
          <CopyValue value={p.callbackUrl} label="callback URL" />
        </div>
        {p.domainVerification && (
          <>
            <p className="mt-1 text-ink">
              Add this DNS TXT record to {p.domains.length > 1 ? "each domain" : p.domains[0]}, then check:
            </p>
            <div className="grid grid-cols-[9rem_1fr] items-center gap-2">
              <span className="text-ink-muted">Host</span>
              <CopyValue value={`${p.domainVerification.recordName}.${p.domains[0]}`} label="record host" />
              <span className="text-ink-muted">Value</span>
              <CopyValue value={p.domainVerification.recordValue} label="record value" />
            </div>
            <div>
              <Button size="sm" leadingIcon={<RefreshCw />} loading={verify.isPending} onClick={() => verify.mutate()}>
                Check DNS
              </Button>
            </div>
          </>
        )}
      </div>
      <Dialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Remove ${p.name}?`}
        description="People on these domains will sign in with a password and second factor instead. If this is your last verified provider, enforcement is turned off."
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>
              Remove
            </Button>
          </>
        }
      />
    </li>
  );
}

export function SsoTab() {
  const sso = useOrgSso();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const update = useMutation({
    mutationFn: api.sso.update,
    onSuccess: (next) => {
      queryClient.setQueryData(qk.sso, next);
      toast({ tone: "success", title: "SSO settings saved" });
    },
    onError: (e) => toast({ tone: "error", title: "Couldn't save", description: errorMessage(e) }),
  });

  if (sso.isPending) return <Skeleton className="h-64 rounded-lg" />;
  if (sso.isError) return <ErrorState error={sso.error} resource="SSO settings" onRetry={() => sso.refetch()} />;
  const hasVerified = sso.data.providers.some((p) => p.domainVerified);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          title="Identity providers"
          description="OpenID Connect or SAML. New people are added to this organization as members on first sign-in."
          actions={
            <Button variant="primary" onClick={() => setAdding(true)}>
              Add provider
            </Button>
          }
        />
        <CardContent>
          {sso.data.providers.length === 0 ? (
            <EmptyState
              icon={<Building2 />}
              title="No SSO provider yet"
              description="Connect Okta, Entra ID, Google Workspace or any OIDC/SAML identity provider."
            />
          ) : (
            <ul className="flex flex-col divide-y divide-line">
              {sso.data.providers.map((p) => (
                <ProviderRow key={p.id} p={p} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader title="Policy" />
        <CardContent className="flex flex-col gap-5">
          <Field
            inline
            label="Enforce SSO"
            hint={
              hasVerified
                ? "People on your verified domains can only sign in through your identity provider (no password or passkey)."
                : "Verify a domain first."
            }
          >
            <Switch
              checked={sso.data.enforceSso}
              disabled={!hasVerified || update.isPending}
              onCheckedChange={(enforceSso) => update.mutate({ enforceSso })}
            />
          </Field>
          <Field
            inline
            label="Also require slai two-factor for SSO users"
            hint="Off: your identity provider's MFA satisfies slai's requirement. On: SSO users also enroll an authenticator app or passkey."
          >
            <Switch
              checked={sso.data.requireMfaForSso}
              disabled={update.isPending}
              onCheckedChange={(requireMfaForSso) => update.mutate({ requireMfaForSso })}
            />
          </Field>
        </CardContent>
      </Card>
      <AddProviderDialog open={adding} onOpenChange={setAdding} />
    </div>
  );
}
