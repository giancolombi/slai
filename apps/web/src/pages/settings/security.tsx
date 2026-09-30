import type { Passkey } from "@slai/shared";
import { Badge, Button, Card, CardContent, CardHeader, cn, Dialog, Field, Input, Skeleton, toast } from "@slai/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fingerprint, KeyRound, ListRestart, ShieldCheck, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { ErrorState } from "../../components/page";
import { api, errorMessage, isApiError } from "../../lib/api";
import { passkeyError, passkeysSupported, registerPasskey } from "../../lib/passkeys";
import { qk, useMe, usePasskeys } from "../../lib/queries";
import { BackupCodesPanel } from "../auth/mfa-setup";

/** Asks for the password (when the account has one) before a sensitive change. */
function PasswordDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  danger,
  needsPassword,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  danger?: boolean;
  needsPassword: boolean;
  onConfirm: (password: string | undefined) => Promise<unknown>;
}) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const run = useMutation({
    mutationFn: () => onConfirm(needsPassword ? password : undefined),
    onSuccess: () => {
      setPassword("");
      onOpenChange(false);
    },
    onError: (e) =>
      setError(isApiError(e) && e.code === "invalid_password" ? "That password is not correct." : errorMessage(e)),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (needsPassword && !password) return setError("Enter your password.");
    setError(null);
    run.mutate();
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant={danger ? "danger" : "primary"} loading={run.isPending} onClick={submit}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {needsPassword && (
        <form onSubmit={submit} noValidate>
          <Field label="Password" error={error ?? undefined}>
            <Input
              type="password"
              autoComplete="current-password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
        </form>
      )}
      {!needsPassword && error && <p className="text-sm text-breached-text">{error}</p>}
    </Dialog>
  );
}

function FactorIcon({ on, children }: { on: boolean; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "flex size-10 shrink-0 items-center justify-center rounded-lg border",
        on ? "border-ok-border bg-ok-subtle text-ok-text" : "border-line bg-sunken text-ink-muted",
      )}
    >
      {children}
    </span>
  );
}

export function SecurityTab() {
  const { data: me } = useMe();
  const passkeys = usePasskeys();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<"regenerate" | "disable" | null>(null);
  const [newCodes, setNewCodes] = useState<string[] | null>(null);
  const [removing, setRemoving] = useState<Passkey | null>(null);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: qk.me });
    void queryClient.invalidateQueries({ queryKey: qk.passkeys });
  };
  const addPasskey = useMutation({
    mutationFn: () => registerPasskey(`Passkey ${new Date().toLocaleDateString()}`),
    onSuccess: () => {
      toast({ tone: "success", title: "Passkey added" });
      refresh();
    },
    onError: (e) =>
      toast({
        tone: "error",
        title: "Couldn't add a passkey",
        description: isApiError(e) ? errorMessage(e) : passkeyError(e),
      }),
  });
  const removePasskey = useMutation({
    mutationFn: (p: Passkey) => api.passkeys.remove(p.id),
    onSuccess: () => {
      setRemoving(null);
      toast({ tone: "success", title: "Passkey removed" });
      refresh();
    },
    onError: (e) => toast({ tone: "error", title: "Couldn't remove the passkey", description: errorMessage(e) }),
  });

  if (!me) return <Skeleton className="h-40 rounded-lg" />;
  const s = me.security;
  const factorCount = (s.totp ? 1 : 0) + s.passkeys;
  const lastFactor = s.authMethod !== "sso" && factorCount <= 1;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          title="Two-factor authentication"
          description={`Required for every slai account. Signed in as ${me.user.email}${
            s.authMethod === "sso" ? " through single sign-on" : ""
          }.`}
        />
        <CardContent className="flex flex-col gap-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <FactorIcon on={s.totp}>
                <KeyRound className="size-5" aria-hidden />
              </FactorIcon>
              <div>
                <p className="flex items-center gap-2 text-sm font-medium text-ink">
                  Authenticator app
                  <Badge tone={s.totp ? "ok" : "neutral"} size="sm">
                    {s.totp ? "On" : "Not set up"}
                  </Badge>
                </p>
                <p className="text-xs text-ink-muted">
                  {s.totp
                    ? "A 6-digit code from your app, or a backup code."
                    : "Add an app such as 1Password or Authy."}
                </p>
              </div>
            </div>
            {s.totp ? (
              <Button
                variant="secondary"
                disabled={lastFactor}
                title={lastFactor ? "Add a passkey first: a second factor is required." : undefined}
                onClick={() => setDialog("disable")}
              >
                Remove
              </Button>
            ) : (
              <Button asChild variant="primary">
                <Link to="/mfa/setup">Set up</Link>
              </Button>
            )}
          </div>

          {s.totp && (
            <div className="flex flex-wrap items-center justify-between gap-4 border-t border-line pt-5">
              <div className="flex items-center gap-3">
                <FactorIcon on>
                  <ListRestart className="size-5" aria-hidden />
                </FactorIcon>
                <div>
                  <p className="text-sm font-medium text-ink">Backup codes</p>
                  <p className="text-xs text-ink-muted">Ten single-use codes. Regenerating replaces the old ones.</p>
                </div>
              </div>
              <Button variant="secondary" onClick={() => setDialog("regenerate")}>
                Regenerate
              </Button>
            </div>
          )}
          {newCodes && (
            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium text-ink">Your new backup codes (shown once)</p>
              <BackupCodesPanel codes={newCodes} email={me.user.email} />
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader
          title="Passkeys"
          description="Sign in with Touch ID, Windows Hello or a security key. A passkey is a full second factor."
          actions={
            passkeysSupported() ? (
              <Button leadingIcon={<Fingerprint />} loading={addPasskey.isPending} onClick={() => addPasskey.mutate()}>
                Add a passkey
              </Button>
            ) : undefined
          }
        />
        <CardContent>
          {passkeys.isPending ? (
            <Skeleton className="h-12 rounded-md" />
          ) : passkeys.isError ? (
            <ErrorState error={passkeys.error} resource="your passkeys" onRetry={() => passkeys.refetch()} compact />
          ) : passkeys.data.length === 0 ? (
            <p className="text-sm text-ink-muted">No passkeys yet.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line">
              {passkeys.data.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="flex items-center gap-3">
                    <Fingerprint className="size-4 text-ink-muted" aria-hidden />
                    <div>
                      <p className="text-sm font-medium text-ink">{p.name ?? "Passkey"}</p>
                      <p className="text-xs text-ink-muted">
                        Added {new Date(p.createdAt).toLocaleDateString()}
                        {p.backedUp ? " · synced" : " · this device only"}
                      </p>
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    leadingIcon={<Trash2 />}
                    disabled={lastFactor}
                    title={lastFactor ? "Add another factor first: a second factor is required." : undefined}
                    onClick={() => setRemoving(p)}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader title="Sessions" />
        <CardContent className="flex items-start gap-3 text-sm text-ink-muted">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-ok-text" aria-hidden />
          <span>
            Sessions use a secure, http-only cookie and end after 12 hours of inactivity or 7 days at most. Sign-ins,
            factor changes and backup-code use are recorded in the{" "}
            <Link to="/audit" className="font-medium text-accent-text hover:underline">
              audit log
            </Link>
            .
          </span>
        </CardContent>
      </Card>

      <PasswordDialog
        open={dialog === "regenerate"}
        onOpenChange={(o) => !o && setDialog(null)}
        title="Regenerate backup codes"
        description="Your current backup codes stop working."
        confirmLabel="Regenerate"
        needsPassword={s.hasPassword}
        onConfirm={async (password) => setNewCodes((await api.totp.regenerateBackupCodes(password)).backupCodes)}
      />
      <PasswordDialog
        open={dialog === "disable"}
        onOpenChange={(o) => !o && setDialog(null)}
        title="Remove authenticator app"
        description="You'll sign in with your passkey instead. Backup codes stop working."
        confirmLabel="Remove"
        danger
        needsPassword={s.hasPassword}
        onConfirm={async (password) => {
          await api.totp.disable(password);
          setNewCodes(null);
          refresh();
          toast({ tone: "success", title: "Authenticator app removed" });
        }}
      />
      <Dialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title="Remove passkey?"
        description={`"${removing?.name ?? "Passkey"}" will no longer sign you in.`}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={removePasskey.isPending}
              onClick={() => removing && removePasskey.mutate(removing)}
            >
              Remove
            </Button>
          </>
        }
      />
    </div>
  );
}
