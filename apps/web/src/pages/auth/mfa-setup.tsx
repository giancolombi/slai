import { Button, IconButton, Skeleton, toast } from "@slai/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Check, CircleAlert, Copy, ExternalLink, KeyRound } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { ErrorState } from "../../components/page";
import { api, errorMessage, isApiError } from "../../lib/api";
import { qk } from "../../lib/queries";
import { AuthHeading } from "./auth-layout";
import { CodeInput } from "./code-input";

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

export function MfaSetupPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    document.title = "Set up two-factor · slai";
  }, []);

  // POST /auth/mfa/setup issues a fresh secret; run it once per visit.
  const setup = useQuery({
    queryKey: ["mfa-setup"],
    queryFn: api.auth.mfaSetup,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    retry: false,
  });

  const verify = useMutation({
    mutationFn: api.auth.mfaVerify,
    onSuccess: async (me) => {
      queryClient.setQueryData(qk.me, me);
      void queryClient.invalidateQueries({ queryKey: qk.members });
      toast({ tone: "success", title: "Two-factor is on", description: "You'll enter a code each time you sign in." });
      await navigate({ to: "/settings" });
    },
    onError: (e) => {
      setCode("");
      setError(
        isApiError(e) && e.code === "invalid_totp" ? "That code didn't match. Try the current code." : errorMessage(e),
      );
    },
  });

  const copy = async (secret: string) => {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({ tone: "error", title: "Couldn't copy", description: "Select the key and copy it manually." });
    }
  };

  const submit = (value: string) => {
    if (value.length !== 6) return setError("Enter all 6 digits.");
    setError(null);
    verify.mutate(value);
  };

  return (
    <>
      <div className="mb-5 flex size-11 items-center justify-center rounded-xl border border-line bg-surface text-accent-text shadow-xs">
        <KeyRound className="size-5" aria-hidden />
      </div>
      <AuthHeading
        title="Set up two-factor"
        description="Protect your account with a time-based code from an authenticator app such as 1Password, Authy or Google Authenticator."
      />
      {setup.isError ? (
        <ErrorState error={setup.error} resource="your setup key" onRetry={() => setup.refetch()} compact />
      ) : (
        <ol className="flex flex-col gap-7">
          <Step n={1} title="Add slai to your authenticator">
            {setup.isPending ? (
              <Skeleton className="h-20 w-full" />
            ) : (
              <div className="rounded-lg border border-line bg-surface p-3.5 shadow-xs">
                <p className="text-xs text-ink-muted">Setup key</p>
                <div className="mt-1 flex items-center justify-between gap-2">
                  <code className="font-mono text-[13px] font-medium break-all text-ink tnum select-all">
                    {setup.data.secret.match(/.{1,4}/g)?.join(" ")}
                  </code>
                  <IconButton
                    size="sm"
                    label={copied ? "Copied" : "Copy setup key"}
                    icon={copied ? <Check className="text-ok-text" /> : <Copy />}
                    onClick={() => copy(setup.data.secret)}
                  />
                </div>
                <a
                  href={setup.data.otpauthUrl}
                  className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-accent-text hover:underline"
                >
                  Open in authenticator app
                  <ExternalLink className="size-3.5" aria-hidden />
                </a>
              </div>
            )}
            <p className="text-xs text-ink-muted">
              Choose “Enter a setup key” in your app, name it slai, and paste the key. The key is time-based.
            </p>
          </Step>
          <Step n={2} title="Enter the 6-digit code it shows">
            <form
              onSubmit={(e: FormEvent) => {
                e.preventDefault();
                submit(code);
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
                onComplete={(v) => !verify.isPending && submit(v)}
                invalid={Boolean(error)}
                disabled={verify.isPending || setup.isPending}
                describedBy={error ? "mfa-setup-error" : undefined}
              />
              {error && (
                <p id="mfa-setup-error" role="alert" className="flex items-center gap-1.5 text-sm text-breached-text">
                  <CircleAlert className="size-4 shrink-0" aria-hidden />
                  {error}
                </p>
              )}
              <Button type="submit" variant="primary" size="lg" loading={verify.isPending} disabled={setup.isPending}>
                Turn on two-factor
              </Button>
            </form>
          </Step>
        </ol>
      )}
      <p className="mt-7 text-center text-sm text-ink-muted">
        <Link to="/settings" className="font-medium text-accent-text hover:underline">
          Not now, back to settings
        </Link>
      </p>
    </>
  );
}
