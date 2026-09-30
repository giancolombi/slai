import { Button } from "@slai/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link, Navigate, useNavigate } from "@tanstack/react-router";
import { CircleAlert, ShieldCheck } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { api, errorMessage, isApiError } from "../../lib/api";
import { destinationAfterLogin } from "./after-login";
import { AuthHeading } from "./auth-layout";
import { CodeInput } from "./code-input";
import { getPendingLogin, setPendingLogin } from "./pending";

const route = getRouteApi("/_auth/mfa");

export function MfaChallengePage() {
  const { redirect } = route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [pending] = useState(getPendingLogin);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.title = "Two-factor authentication · slai";
  }, []);

  const verify = useMutation({
    mutationFn: (totp: string) => api.auth.login({ email: pending!.email, password: pending!.password, totp }),
    onSuccess: async (me) => {
      setPendingLogin(null);
      const to = await destinationAfterLogin(queryClient, me, redirect);
      await navigate({ to });
    },
    onError: (e) => {
      setCode("");
      setError(
        isApiError(e) && e.code === "invalid_totp"
          ? "That code didn't match. Codes change every 30 seconds; try the current one."
          : errorMessage(e),
      );
    },
  });

  if (!pending) return <Navigate to="/login" search={{ redirect }} replace />;

  const submit = (value: string) => {
    if (value.length !== 6) {
      setError("Enter all 6 digits.");
      return;
    }
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
            Enter the 6-digit code from your authenticator app for{" "}
            <span className="font-medium text-ink">{pending.email}</span>.
          </>
        }
      />
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          submit(code);
        }}
        noValidate
        className="flex flex-col gap-4"
      >
        <CodeInput
          value={code}
          onChange={(v) => {
            setCode(v);
            if (error) setError(null);
          }}
          onComplete={(v) => !verify.isPending && submit(v)}
          invalid={Boolean(error)}
          disabled={verify.isPending}
          describedBy={error ? "mfa-error" : undefined}
          autoFocus
        />
        {error && (
          <p id="mfa-error" role="alert" className="flex items-center gap-1.5 text-sm text-breached-text">
            <CircleAlert className="size-4 shrink-0" aria-hidden />
            {error}
          </p>
        )}
        <Button type="submit" variant="primary" size="lg" loading={verify.isPending} className="mt-1">
          Verify
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-ink-muted">
        Lost your device? Ask an admin to reset two-factor.{" "}
        <Link to="/login" search={{ redirect }} className="font-medium text-accent-text hover:underline">
          Use another account
        </Link>
      </p>
    </>
  );
}
