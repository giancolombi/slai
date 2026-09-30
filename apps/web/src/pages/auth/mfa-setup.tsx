import type { TotpEnrollment } from "@slai/shared";
import { Button, Checkbox, Field, IconButton, Input, Skeleton, toast } from "@slai/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Check, CircleAlert, Copy, Download, Fingerprint, KeyRound, Smartphone } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { type FormEvent, useEffect, useState } from "react";
import { api, errorMessage, isApiError } from "../../lib/api";
import { passkeyError, passkeysSupported, registerPasskey } from "../../lib/passkeys";
import { meQuery, qk } from "../../lib/queries";
import { destinationAfterLogin } from "./after-login";
import { AuthHeading, FormAlert } from "./auth-layout";
import { CodeInput } from "./code-input";

type Stage = "choose" | "password" | "scan" | "codes";

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3.5">
      <span
        aria-hidden
        className="mt-px flex size-6 shrink-0 items-center justify-center rounded-full border border-line-strong bg-surface font-mono text-xs font-semibold text-ink-muted"
      >
        {n}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        {children}
      </div>
    </li>
  );
}

/** Backup codes, shown once, with copy and download. Used by enrollment and Settings → Security. */
export function BackupCodesPanel({ codes, email }: { codes: string[]; email: string }) {
  const [copied, setCopied] = useState(false);
  const text = `slai backup codes for ${email}\nEach code works once. Keep them somewhere safe.\n\n${codes.join("\n")}\n`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({ tone: "error", title: "Couldn't copy", description: "Select the codes and copy them manually." });
    }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "slai-backup-codes.txt";
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="rounded-lg border border-line bg-surface p-3.5 shadow-xs">
      <ul
        className="grid grid-cols-2 gap-x-6 gap-y-1.5 font-mono text-[13px] text-ink tnum select-all"
        aria-label="Backup codes"
      >
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="mt-3 flex gap-2">
        <Button size="sm" leadingIcon={copied ? <Check className="text-ok-text" /> : <Copy />} onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </Button>
        <Button size="sm" leadingIcon={<Download />} onClick={download}>
          Download .txt
        </Button>
      </div>
    </div>
  );
}

/**
 * Mandatory second-factor enrollment. Every password account lands here after its
 * first sign-in (the API refuses everything else until a factor exists).
 */
export function MfaSetupPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const me = useQuery(meQuery);
  const [stage, setStage] = useState<Stage>("choose");
  const [password, setPassword] = useState("");
  const [enrollment, setEnrollment] = useState<TotpEnrollment | null>(null);
  const [code, setCode] = useState("");
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.title = "Set up two-factor · slai";
  }, []);

  const finish = async () => {
    await queryClient.invalidateQueries({ queryKey: qk.me });
    const fresh = await queryClient.fetchQuery(meQuery);
    await navigate({ to: await destinationAfterLogin(queryClient, fresh) });
  };

  const enable = useMutation({
    mutationFn: () => api.totp.enable(me.data?.security.hasPassword ? password : undefined),
    onSuccess: (e) => {
      setEnrollment(e);
      setError(null);
      setStage("scan");
    },
    onError: (e) =>
      setError(isApiError(e) && e.code === "invalid_password" ? "That password is not correct." : errorMessage(e)),
  });

  const verify = useMutation({
    mutationFn: api.auth.verifyTotp,
    onSuccess: (result) => {
      if (result.status !== "mfa_required") queryClient.setQueryData(qk.me, result.me);
      setStage("codes");
    },
    onError: (e) => {
      setCode("");
      setError(
        isApiError(e) && e.code === "invalid_code" ? "That code didn't match. Try the current code." : errorMessage(e),
      );
    },
  });

  const passkey = useMutation({
    mutationFn: () => registerPasskey("Passkey"),
    onSuccess: async () => {
      toast({ tone: "success", title: "Passkey added", description: "You'll use it each time you sign in." });
      await finish();
    },
    onError: (e) => setError(isApiError(e) ? errorMessage(e) : passkeyError(e)),
  });

  if (me.isPending) return <Skeleton className="h-64 w-full" />;
  if (me.isError) return <FormAlert>{errorMessage(me.error)}</FormAlert>;
  const alreadyEnrolled = me.data.security.totp && stage === "choose";

  const copySecret = async (secret: string) => {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({ tone: "error", title: "Couldn't copy", description: "Select the key and copy it manually." });
    }
  };
  const submitCode = (value: string) => {
    if (value.length !== 6) return setError("Enter all 6 digits.");
    setError(null);
    verify.mutate(value);
  };

  return (
    <>
      <div className="mb-5 flex size-11 items-center justify-center rounded-xl border border-line bg-surface text-accent-text shadow-xs">
        <KeyRound className="size-5" aria-hidden />
      </div>

      {stage === "choose" && (
        <>
          <AuthHeading
            title="Set up two-factor authentication"
            description={
              alreadyEnrolled
                ? "An authenticator app is already set up. You can add a passkey as well."
                : "slai requires a second factor for every account. Choose how you'll confirm it's you."
            }
          />
          {error && <FormAlert>{error}</FormAlert>}
          <div className="mt-2 flex flex-col gap-3">
            {!alreadyEnrolled && (
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  if (me.data.security.hasPassword) setStage("password");
                  else enable.mutate();
                }}
                className="flex items-start gap-3 rounded-lg border border-line-strong bg-surface p-4 text-left shadow-xs hover:bg-hover"
              >
                <Smartphone className="mt-0.5 size-5 text-accent-text" aria-hidden />
                <span>
                  <span className="block text-sm font-semibold text-ink">Authenticator app (recommended)</span>
                  <span className="block text-xs text-ink-muted">
                    1Password, Authy, Google Authenticator… plus ten single-use backup codes.
                  </span>
                </span>
              </button>
            )}
            {passkeysSupported() && (
              <button
                type="button"
                disabled={passkey.isPending}
                onClick={() => {
                  setError(null);
                  passkey.mutate();
                }}
                className="flex items-start gap-3 rounded-lg border border-line-strong bg-surface p-4 text-left shadow-xs hover:bg-hover disabled:opacity-60"
              >
                <Fingerprint className="mt-0.5 size-5 text-accent-text" aria-hidden />
                <span>
                  <span className="block text-sm font-semibold text-ink">
                    {passkey.isPending ? "Waiting for your device…" : "Passkey instead"}
                  </span>
                  <span className="block text-xs text-ink-muted">
                    Touch ID, Windows Hello, or a security key. Nothing to type.
                  </span>
                </span>
              </button>
            )}
          </div>
          <p className="mt-7 text-center text-sm text-ink-muted">
            {alreadyEnrolled ? (
              <Link to="/settings" hash="security" className="font-medium text-accent-text hover:underline">
                Back to settings
              </Link>
            ) : (
              "You can't use slai until this is done. Your admin can help if you're stuck."
            )}
          </p>
        </>
      )}

      {stage === "password" && (
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (!password) return setError("Enter your password.");
            enable.mutate();
          }}
          noValidate
          className="flex flex-col gap-4"
        >
          <AuthHeading title="Confirm your password" description="Before adding a second factor, confirm it's you." />
          {error && <FormAlert>{error}</FormAlert>}
          <Field label="Password">
            <Input
              type="password"
              autoComplete="current-password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <Button type="submit" variant="primary" size="lg" loading={enable.isPending}>
            Continue
          </Button>
          <Button variant="ghost" onClick={() => setStage("choose")}>
            Back
          </Button>
        </form>
      )}

      {stage === "scan" && enrollment && (
        <>
          <AuthHeading title="Add slai to your authenticator" />
          <ol className="flex flex-col gap-7">
            <Step n={1} title="Scan the QR code">
              <div className="flex flex-wrap items-center gap-4 rounded-lg border border-line bg-surface p-3.5 shadow-xs">
                <div className="rounded-md bg-white p-2" data-testid="totp-qr">
                  <QRCodeSVG value={enrollment.otpauthUrl} size={144} marginSize={0} title="TOTP QR code" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-ink-muted">Can't scan? Enter this setup key</p>
                  <div className="mt-1 flex items-center gap-2">
                    <code className="font-mono text-[13px] font-medium break-all text-ink tnum select-all">
                      {enrollment.secret.match(/.{1,4}/g)?.join(" ")}
                    </code>
                    <IconButton
                      size="sm"
                      label={copied ? "Copied" : "Copy setup key"}
                      icon={copied ? <Check className="text-ok-text" /> : <Copy />}
                      onClick={() => copySecret(enrollment.secret)}
                    />
                  </div>
                </div>
              </div>
            </Step>
            <Step n={2} title="Enter the 6-digit code it shows">
              <form
                onSubmit={(e: FormEvent) => {
                  e.preventDefault();
                  submitCode(code);
                }}
                noValidate
                className="flex flex-col gap-3"
              >
                <CodeInput
                  value={code}
                  onChange={(v) => {
                    setCode(v);
                    if (error) setError(null);
                  }}
                  onComplete={(v) => !verify.isPending && submitCode(v)}
                  invalid={Boolean(error)}
                  disabled={verify.isPending}
                  describedBy={error ? "mfa-setup-error" : undefined}
                  autoFocus
                />
                {error && (
                  <p id="mfa-setup-error" role="alert" className="flex items-center gap-1.5 text-sm text-breached-text">
                    <CircleAlert className="size-4 shrink-0" aria-hidden />
                    {error}
                  </p>
                )}
                <Button type="submit" variant="primary" size="lg" loading={verify.isPending}>
                  Verify and continue
                </Button>
              </form>
            </Step>
          </ol>
        </>
      )}

      {stage === "codes" && enrollment && (
        <>
          <AuthHeading
            title="Save your backup codes"
            description="If you lose your device, each code signs you in once. They won't be shown again."
          />
          <BackupCodesPanel codes={enrollment.backupCodes} email={me.data.user.email} />
          <Field inline label="I saved these codes somewhere safe" className="mt-5">
            <Checkbox checked={saved} onCheckedChange={(v) => setSaved(v === true)} />
          </Field>
          <Button variant="primary" size="lg" className="mt-5 w-full" disabled={!saved} onClick={() => void finish()}>
            Continue to slai
          </Button>
        </>
      )}
    </>
  );
}
