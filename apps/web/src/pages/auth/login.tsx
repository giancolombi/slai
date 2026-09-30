import { loginBody } from "@slai/shared";
import { Button, Field, Input, Tooltip } from "@slai/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { api, errorMessage, isApiError } from "../../lib/api";
import { destinationAfterLogin } from "./after-login";
import { AuthHeading, FormAlert } from "./auth-layout";
import { type FieldErrors, zodFieldErrors } from "./form-errors";
import { setPendingLogin } from "./pending";

const route = getRouteApi("/_auth/login");

export function LoginPage() {
  const { redirect } = route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    document.title = "Sign in · slai";
  }, []);

  const login = useMutation({
    mutationFn: api.auth.login,
    onSuccess: async (me) => {
      setPendingLogin(null);
      const to = await destinationAfterLogin(queryClient, me, redirect);
      await navigate({ to });
    },
    onError: (e, vars) => {
      if (isApiError(e) && e.isMfaRequired) {
        setPendingLogin({ email: vars.email, password: vars.password });
        void navigate({ to: "/mfa", search: { redirect } });
        return;
      }
      setFormError(
        isApiError(e) && e.code === "invalid_credentials" ? "Email or password is incorrect." : errorMessage(e),
      );
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const parsed = loginBody.safeParse({ email: email.trim(), password });
    if (!parsed.success) {
      const fe = zodFieldErrors(parsed.error);
      setErrors({
        email: fe.email ? "Enter a valid email address." : "",
        password: fe.password ? "Enter your password." : "",
      });
      return;
    }
    setErrors({});
    login.mutate(parsed.data);
  };

  return (
    <>
      <AuthHeading title="Sign in to slai" description="Welcome back. Your clocks kept running while you were away." />
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        {formError && <FormAlert>{formError}</FormAlert>}
        <Field label="Work email" error={errors.email || undefined}>
          <Input
            type="email"
            autoComplete="email"
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
          />
        </Field>
        <Field
          label="Password"
          error={errors.password || undefined}
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
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Button
          type="submit"
          variant="primary"
          size="lg"
          loading={login.isPending}
          trailingIcon={<ArrowRight />}
          className="mt-2"
        >
          Sign in
        </Button>
      </form>
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
