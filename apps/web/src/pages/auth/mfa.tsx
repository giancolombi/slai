import type { SecondFactor, SignInResult } from "@slai/shared";
import { Button, Field, Input, SegmentedControl } from "@slai/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link, Navigate, useNavigate } from "@tanstack/react-router";
import { CircleAlert, Fingerprint, ShieldCheck } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { api, errorMessage, isApiError } from "../../lib/api";
import { stepUpMethods } from "../../lib/auth-flow";
import { passkeyError, signInWithPasskey } from "../../lib/passkeys";
import { qk } from "../../lib/queries";
import { destinationAfterLogin } from "./after-login";
import { AuthHeading } from "./auth-layout";
import { CodeInput } from "./code-input";
import { getPendingLogin, setPendingLogin } from "./pending";

const route = getRouteApi("/_auth/mfa");

const LABELS: Record<SecondFactor, string> = {
  totp: "Authenticator app",
  backup_code: "Backup code",
  passkey: "Passkey",
};

/**
 * The second factor, for a sign-in in progress (the password step passed) or
 * for a signed-in session that still has to verify (step-up).
 */
export function MfaChallengePage() {
  const { redirect } = route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [pending] = useState(getPendingLogin);
  // Step-up: no sign-in in progress, but the session exists and must verify.
  const session = useQuery({ queryKey: qk.me, queryFn: api.auth.me, enabled: !pending, retry: false });
  const methods: SecondFactor[] = pending?.methods ?? (session.data ? stepUpMethods(session.data) : []);
  const [method, setMethod] = useState<SecondFactor | null>(null);
  const active = method ?? methods[0] ?? null;
  const [code, setCode] = useState("");
  const [backup, setBackup] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.title = "Two-factor authentication · slai";
  }, []);

  const done = async (result: SignInResult) => {
    if (result.status === "mfa_required") {
      setError("That didn't complete sign-in. Try another method.");
      return;
    }
    setPendingLogin(null);
    queryClient.clear();
    if (result.status === "mfa_enrollment_required") {
      queryClient.setQueryData(qk.me, result.me);
      return navigate({ to: "/mfa/setup" });
    }
    await navigate({ to: await destinationAfterLogin(queryClient, result.me, redirect) });
  };
  const fail = (e: unknown) => {
    setCode("");
    if (isApiError(e) && e.code === "mfa_challenge_expired") {
      setPendingLogin(null);
      void navigate({ to: "/login", search: { redirect } });
      return;
    }
    setError(
      isApiError(e) && e.code === "invalid_code"
        ? active === "backup_code"
          ? "That backup code isn't valid or was already used."
          : "That code didn't match. Codes change every 30 seconds; try the current one."
        : isApiError(e)
          ? errorMessage(e)
          : passkeyError(e),
    );
  };

  const verify = useMutation({
    mutationFn: async (value: string): Promise<SignInResult> =>
      active === "backup_code" ? api.auth.verifyBackupCode(value) : api.auth.verifyTotp(value),
    onSuccess: done,
    onError: fail,
  });
  const passkey = useMutation({ mutationFn: signInWithPasskey, onSuccess: done, onError: fail });

  if (!pending && session.isError) return <Navigate to="/login" search={{ redirect }} replace />;
  if (!pending && session.isPending) return null;

  const who = pending?.email ?? session.data?.user.email ?? "";
  const submitCode = (value: string) => {
    if (value.length !== 6) return setError("Enter all 6 digits.");
    setError(null);
    verify.mutate(value);
  };

  return (
    <>
      <div className="mb-5 flex size-11 items-center justify-center rounded-xl border border-line bg-surface text-accent-text shadow-xs">
        <ShieldCheck className="size-5" aria-hidden />
      </div>
      <AuthHeading
        title="Two-factor authentication"
        description={
          <>
            Confirm it's you, <span className="font-medium text-ink">{who}</span>.
          </>
        }
      />
      {methods.length > 1 && (
        <SegmentedControl
          aria-label="Second factor"
          className="mb-5"
          value={active ?? ""}
          onValueChange={(v) => {
            setMethod(v as SecondFactor);
            setError(null);
          }}
          options={methods.map((m) => ({ value: m, label: LABELS[m] }))}
        />
      )}

      {active === "totp" && (
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            submitCode(code);
          }}
          noValidate
          className="flex flex-col gap-4"
        >
          <p className="text-sm text-ink-muted">Enter the 6-digit code from your authenticator app.</p>
          <CodeInput
            value={code}
            onChange={(v) => {
              setCode(v);
              if (error) setError(null);
            }}
            onComplete={(v) => !verify.isPending && submitCode(v)}
            invalid={Boolean(error)}
            disabled={verify.isPending}
            describedBy={error ? "mfa-error" : undefined}
            autoFocus
          />
          <Button type="submit" variant="primary" size="lg" loading={verify.isPending}>
            Verify
          </Button>
        </form>
      )}

      {active === "backup_code" && (
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (backup.trim().length < 6) return setError("Enter one of your backup codes.");
            setError(null);
            verify.mutate(backup.trim());
          }}
          noValidate
          className="flex flex-col gap-4"
        >
          <Field label="Backup code" hint="Each backup code works once.">
            <Input
              value={backup}
              onChange={(e) => setBackup(e.target.value)}
              autoComplete="one-time-code"
              placeholder="xxxxx-xxxxx"
              className="font-mono"
              autoFocus
            />
          </Field>
          <Button type="submit" variant="primary" size="lg" loading={verify.isPending}>
            Verify backup code
          </Button>
        </form>
      )}

      {active === "passkey" && (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-ink-muted">Use the passkey saved on this device or your security key.</p>
          <Button
            variant="primary"
            size="lg"
            leadingIcon={<Fingerprint />}
            loading={passkey.isPending}
            onClick={() => passkey.mutate()}
          >
            Use your passkey
          </Button>
        </div>
      )}

      {error && (
        <p id="mfa-error" role="alert" className="mt-4 flex items-center gap-1.5 text-sm text-breached-text">
          <CircleAlert className="size-4 shrink-0" aria-hidden />
          {error}
        </p>
      )}
      <p className="mt-6 text-center text-sm text-ink-muted">
        Lost your device and backup codes? Ask an admin in your organization.{" "}
        <Link to="/login" search={{ redirect }} className="font-medium text-accent-text hover:underline">
          Use another account
        </Link>
      </p>
    </>
  );
}
