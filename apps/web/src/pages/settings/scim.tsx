/** Settings → Single sign-on → SCIM provisioning (T-18): tokens and IdP group → role mappings. */
import { SCIM_ROLES, type ScimGroupRole, type ScimTokenCreated } from "@slai/shared";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  Dialog,
  Field,
  formatRelative,
  IconButton,
  Input,
  Select,
  Skeleton,
  toast,
} from "@slai/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, KeyRound, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { ErrorState } from "../../components/page";
import { api, errorMessage } from "../../lib/api";
import { ROLE_LABEL } from "../../lib/labels";
import { qk, useOrgScim } from "../../lib/queries";

function Copyable({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <code className="min-w-0 break-all rounded-sm bg-sunken px-1.5 py-0.5 font-mono text-xs text-ink">{value}</code>
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

export function ScimCard({ ssoReady }: { ssoReady: boolean }) {
  const scim = useOrgScim();
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: qk.scim });
  const [tokenName, setTokenName] = useState("");
  const [created, setCreated] = useState<ScimTokenCreated | null>(null);
  const [group, setGroup] = useState("");
  const [role, setRole] = useState<ScimGroupRole["role"]>("admin");

  const createToken = useMutation({
    mutationFn: (name: string) => api.scim.createToken(name),
    onSuccess: (t) => {
      setCreated(t);
      setTokenName("");
      void refresh();
    },
    onError: (e) => toast({ tone: "error", title: "Couldn't create a token", description: errorMessage(e) }),
  });
  const revoke = useMutation({
    mutationFn: api.scim.revokeToken,
    onSuccess: () => {
      void refresh();
      toast({ tone: "success", title: "Token revoked", description: "Your IdP can no longer provision with it." });
    },
    onError: (e) => toast({ tone: "error", title: "Couldn't revoke", description: errorMessage(e) }),
  });
  const map = useMutation({
    mutationFn: api.scim.mapGroup,
    onSuccess: (m) => {
      setGroup("");
      void refresh();
      void queryClient.invalidateQueries({ queryKey: qk.members });
      toast({ tone: "success", title: `${m.groupName} → ${ROLE_LABEL[m.role]}` });
    },
    onError: (e) => toast({ tone: "error", title: "Couldn't save the mapping", description: errorMessage(e) }),
  });
  const unmap = useMutation({
    mutationFn: api.scim.unmapGroup,
    onSuccess: () => void refresh(),
    onError: (e) => toast({ tone: "error", title: "Couldn't remove the mapping", description: errorMessage(e) }),
  });

  const submitToken = (e: FormEvent) => {
    e.preventDefault();
    if (tokenName.trim()) createToken.mutate(tokenName.trim());
  };
  const submitMapping = (e: FormEvent) => {
    e.preventDefault();
    if (group.trim()) map.mutate({ groupName: group.trim(), role });
  };

  return (
    <Card>
      <CardHeader
        title="SCIM provisioning"
        description="Let your identity provider create, update and deactivate members. Deactivating someone at the IdP signs them out of slai."
      />
      <CardContent className="flex flex-col gap-6">
        {scim.isPending ? (
          <Skeleton className="h-32 rounded-md" />
        ) : scim.isError ? (
          <ErrorState error={scim.error} resource="SCIM settings" onRetry={() => scim.refetch()} />
        ) : (
          <>
            <div className="grid grid-cols-[9rem_1fr] items-center gap-2 text-xs">
              <span className="text-ink-muted">SCIM base URL</span>
              <Copyable value={scim.data.baseUrl} label="SCIM base URL" />
            </div>

            <section className="flex flex-col gap-3" aria-labelledby="scim-tokens">
              <h3 id="scim-tokens" className="text-sm font-medium text-ink">
                Tokens
              </h3>
              {scim.data.tokens.length > 0 && (
                <ul className="flex flex-col divide-y divide-line rounded-md border border-line">
                  {scim.data.tokens.map((t) => (
                    <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                      <span className="flex items-center gap-2">
                        <KeyRound className="size-4 text-ink-muted" aria-hidden />
                        <span className="font-medium text-ink">{t.name}</span>
                        <code className="font-mono text-xs text-ink-muted">{t.prefix}…</code>
                        {t.revokedAt ? (
                          <Badge tone="outline" size="sm">
                            Revoked
                          </Badge>
                        ) : (
                          <Badge tone="ok" size="sm">
                            Active
                          </Badge>
                        )}
                      </span>
                      <span className="flex items-center gap-3 text-xs text-ink-muted">
                        {t.lastUsedAt ? `Used ${formatRelative(t.lastUsedAt)}` : "Never used"}
                        {!t.revokedAt && (
                          <Button
                            size="sm"
                            variant="ghost"
                            loading={revoke.isPending && revoke.variables === t.id}
                            onClick={() => revoke.mutate(t.id)}
                          >
                            Revoke
                          </Button>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <form onSubmit={submitToken} className="flex flex-wrap items-end gap-2">
                <Field label="New token name" hint={ssoReady ? undefined : "Verify an SSO domain first."}>
                  <Input
                    placeholder="Okta provisioning"
                    value={tokenName}
                    disabled={!ssoReady}
                    onChange={(e) => setTokenName(e.target.value)}
                  />
                </Field>
                <Button type="submit" disabled={!ssoReady || !tokenName.trim()} loading={createToken.isPending}>
                  Generate token
                </Button>
              </form>
            </section>

            <section className="flex flex-col gap-3" aria-labelledby="scim-groups">
              <div>
                <h3 id="scim-groups" className="text-sm font-medium text-ink">
                  Group → role
                </h3>
                <p className="text-xs text-ink-muted">
                  Once a group is mapped, the IdP sets the roles of provisioned members: the highest role among their
                  mapped groups, or Member. Owners are never changed.
                </p>
              </div>
              {scim.data.groupRoles.length > 0 && (
                <ul className="flex flex-col divide-y divide-line rounded-md border border-line">
                  {scim.data.groupRoles.map((m) => (
                    <li key={m.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                      <span>
                        <code className="font-mono text-xs text-ink">{m.groupName}</code>
                        <span className="text-ink-muted"> → {ROLE_LABEL[m.role]}</span>
                      </span>
                      <IconButton
                        size="sm"
                        label={`Remove mapping for ${m.groupName}`}
                        icon={<Trash2 />}
                        onClick={() => unmap.mutate(m.id)}
                      />
                    </li>
                  ))}
                </ul>
              )}
              <form onSubmit={submitMapping} className="flex flex-wrap items-end gap-2">
                <Field label="IdP group">
                  <Input placeholder="slai-admins" value={group} onChange={(e) => setGroup(e.target.value)} />
                </Field>
                <Field label="Role">
                  <div className="w-36">
                    <Select
                      value={role}
                      onValueChange={(v) => setRole(v as ScimGroupRole["role"])}
                      options={SCIM_ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] }))}
                    />
                  </div>
                </Field>
                <Button type="submit" disabled={!group.trim()} loading={map.isPending}>
                  Map group
                </Button>
              </form>
            </section>
          </>
        )}
      </CardContent>
      <Dialog
        open={created !== null}
        onOpenChange={(o) => !o && setCreated(null)}
        title="Copy your SCIM token"
        description="Paste it into your identity provider's provisioning settings. It is shown only once; slai keeps only a hash."
        footer={
          <Button variant="primary" onClick={() => setCreated(null)}>
            Done
          </Button>
        }
      >
        {created && <Copyable value={created.token} label="SCIM token" />}
      </Dialog>
    </Card>
  );
}
