import { discoverBody, loginBody, type SignInResult } from "@slai/shared";
import { Button, Field, Input, Tooltip } from "@slai/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight, Building2, Fingerprint } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { api, errorMessage, isApiError } from "../../lib/api";
import { type SignInStep, signInStep } from "../../lib/auth-flow";
import { passkeyError, passkeysSupported, signInWithPasskey } from "../../lib/passkeys";
import { destinationAfterLogin } from "./after-login";
import { AuthHeading, FormAlert } from "./auth-layout";
import { setPendingLogin } from "./pending";

const route = getRouteApi("/_auth/login");

export function LoginPage() {
  const { redirect, sso_error } = route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<SignInStep>({ kind: "email" });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(
    sso_error === "idp_mfa_required"
      ? "Your organization requires multi-factor sign-in at your identity provider. Sign in there with MFA and try again."
      : sso_error
        ? "Single sign-on didn't complete. Try again, or ask your admin to check the SSO setup."
        : null,
  );

  useEffect(() => {
    document.title = "Sign in · slai";
  }, []);

  /** Moves the machine on a sign-in result and routes accordingly. */
  const onResult = async (result: SignInResult, from: SignInStep) => {
    const next = signInStep(from, { type: "result", result });
    setStep(next);
    if (next.kind === "second_factor") {
      setPendingLogin({ email: next.email, methods: next.methods });
      await navigate({ to: "/mfa", search: { redirect } });
    } else if (next.kind === "enroll") {
      queryClient.setQueryData(["me"], next.me);
      await navigate({ to: "/mfa/setup" });
    } else if (next.kind === "done") {
      setPendingLogin(null);
      await navigate({ to: await destinationAfterLogin(queryClient, next.me, redirect) });
    }
  };

  const sso = useMutation({
    mutationFn: (target: { email?: string; providerId?: string }) => api.auth.ssoStart({ ...target, redirect }),
    onSuccess: ({ url }) => window.location.assign(url),
    onError: (e) => setFormError(errorMessage(e)),
  });

  const discover = useMutation({
    mutationFn: api.auth.discover,
    onSuccess: (discovery, value) => {
      const next = signInStep(step, { type: "discovered", email: value, discovery });
      setStep(next);
      if (next.kind === "sso") sso.mutate({ providerId: next.providerId });
    },
    onError: (e) => setFormError(errorMessage(e)),
  });

  const signIn = useMutation({
    mutationFn: api.auth.signIn,
    onSuccess: (result) => onResult(result, step),
    onError: (e) => {
      if (isApiError(e) && e.code === "sso_required") {
        const next = signInStep(step, {
          type: "sso_required",
          providerId: step.kind === "password" ? (step.sso?.providerId ?? null) : null,
        });
        setStep(next);
        setFormError("Your organization requires single sign-on.");
        if (next.kind === "sso") sso.mutate({ providerId: next.providerId });
        return;
      }
      setFormError(
        isApiError(e) && e.code === "invalid_credentials" ? "Email or password is incorrect." : errorMessage(e),
      );
    },
  });

  const passkey = useMutation({
    mutationFn: signInWithPasskey,
    onSuccess: (result) => onResult(result, step),
    onError: (e) => setFormError(isApiError(e) ? errorMessage(e) : passkeyError(e)),
  });

  const submitEmail = (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const parsed = discoverBody.safeParse({ email: email.trim() });
    if (!parsed.success) return setFieldError("Enter a valid email address.");
    setFieldError(null);
    discover.mutate(parsed.data.email);
  };

  const submitPassword = (e: FormEvent) => {
    e.preventDefault();
    if (step.kind !== "password") return;
    setFormError(null);
    const parsed = loginBody.safeParse({ email: step.email, password });
    if (!parsed.success) return setFieldError("Enter your password.");
    setFieldError(null);
    signIn.mutate(parsed.data);
  };

  const back = () => {
    setStep(signInStep(step, { type: "back" }));
    setPassword("");
    setFormError(null);
  };

  if (step.kind === "sso") {
    return (
      <>
        <AuthHeading
          title="Continue with single sign-on"
          description={
            <>
              <span className="font-medium text-ink">{step.email}</span> signs in through your organization's identity
              provider.
            </>
          }
        />
        {formError && <FormAlert>{formError}</FormAlert>}
        <div className="mt-4 flex flex-col gap-3">
          <Button
            variant="primary"
            size="lg"
            loading={sso.isPending || sso.isSuccess}
            trailingIcon={<ArrowRight />}
            onClick={() => sso.mutate({ providerId: step.providerId })}
          >
            Continue to your identity provider
          </Button>
          <Button variant="ghost" leadingIcon={<ArrowLeft />} onClick={back}>
            Use another email
          </Button>
        </div>
      </>
    );
  }

  if (step.kind === "password") {
    return (
      <>
        <AuthHeading
          title="Enter your password"
          description={
            <>
              Signing in as <span className="font-medium text-ink">{step.email}</span>.
            </>
          }
        />
        <form onSubmit={submitPassword} noValidate className="flex flex-col gap-4">
          {formError && <FormAlert>{formError}</FormAlert>}
          <Field
            label="Password"
            error={fieldError ?? undefined}
            labelAside={
              <Tooltip content="Password reset is coming soon. Ask an admin in your organization to help.">
                <button type="button" className="text-xs font-medium text-accent-text hover:underline" aria-disabled>
                  Forgot password?
                </button>
              </Tooltip>
            }
          >
            <Input
              type="password"
              autoComplete="current-password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <Button type="submit" variant="primary" size="lg" loading={signIn.isPending} trailingIcon={<ArrowRight />}>
            Sign in
          </Button>
          {step.sso && (
            <Button
              variant="secondary"
              leadingIcon={<Building2 />}
              loading={sso.isPending}
              onClick={() => setStep(signInStep(step, { type: "use_sso" }))}
            >
              Use single sign-on instead
            </Button>
          )}
          <Button variant="ghost" leadingIcon={<ArrowLeft />} onClick={back}>
            Use another email
          </Button>
        </form>
      </>
    );
  }

  return (
    <>
      <AuthHeading title="Sign in to slai" description="Welcome back. Your clocks kept running while you were away." />
      <form onSubmit={submitEmail} noValidate className="flex flex-col gap-4">
        {formError && <FormAlert>{formError}</FormAlert>}
        <Field label="Work email" error={fieldError ?? undefined}>
          <Input
            type="email"
            autoComplete="username webauthn"
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
          />
        </Field>
        <Button type="submit" variant="primary" size="lg" loading={discover.isPending} trailingIcon={<ArrowRight />}>
          Continue
        </Button>
      </form>
      <div className="my-5 flex items-center gap-3 text-xs text-ink-subtle">
        <span className="h-px flex-1 bg-line" />
        or
        <span className="h-px flex-1 bg-line" />
      </div>
      <div className="flex flex-col gap-2.5">
        <Button
          variant="secondary"
          leadingIcon={<Building2 />}
          loading={sso.isPending}
          onClick={() => {
            const parsed = discoverBody.safeParse({ email: email.trim() });
            if (!parsed.success) return setFieldError("Enter your work email to find your SSO provider.");
            setFieldError(null);
            setFormError(null);
            sso.mutate({ email: parsed.data.email });
          }}
        >
          Sign in with SSO
        </Button>
        {passkeysSupported() && (
          <Button
            variant="secondary"
            leadingIcon={<Fingerprint />}
            loading={passkey.isPending}
            onClick={() => {
              setFormError(null);
              passkey.mutate();
            }}
          >
            Sign in with a passkey
          </Button>
        )}
      </div>
      <p className="mt-6 text-center text-sm text-ink-muted">
        New to slai?{" "}
        <Link to="/signup" className="font-medium text-accent-text hover:underline">
          Create an account
        </Link>{" "}
        and run a free Breach Replay.
      </p>
    </>
  );
}
