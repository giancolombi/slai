/**
 * `/invite/:token` (T-59a): accept an invitation. New people create their account
 * here (then mandatory MFA enrollment); existing users sign in the usual way,
 * with SSO when their domain uses it, and come back here to join.
 */
import { acceptInvitationSignupBody, type Me } from "@slai/shared";
import { Button, Field, Input, Skeleton } from "@slai/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ArrowRight, Building2 } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { api, errorMessage, isApiError } from "../../lib/api";
import { inviteStep } from "../../lib/auth-flow";
import { ROLE_LABEL } from "../../lib/labels";
import { qk } from "../../lib/queries";
import { AuthHeading, FormAlert } from "./auth-layout";
import { PasswordHint } from "./signup";

const CLOSED: Record<"accepted" | "expired" | "revoked", string> = {
  accepted: "This invitation was already used. Sign in to continue.",
  expired: "This invitation has expired. Ask whoever invited you to send a new one.",
  revoked: "This invitation was withdrawn. Ask whoever invited you if you still need access.",
};

export function InvitePage() {
  const { token } = useParams({ from: "/_auth/invite/$token" });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const here = `/invite/${token}`;
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.title = "Accept invitation · slai";
  }, []);

  const preview = useQuery({ queryKey: ["invitation", token], queryFn: () => api.invitations.preview(token) });
  // Signed out is a normal state here, not an error to redirect on.
  const me = useQuery({
    queryKey: ["invitation-me"],
    queryFn: () => api.auth.me().catch((e) => (isApiError(e) && e.status === 401 ? null : Promise.reject(e))),
  });

  const joined = async (m: Me) => {
    queryClient.clear();
    queryClient.setQueryData(qk.me, m);
    await navigate({ to: "/" });
  };
  const accept = useMutation({
    mutationFn: () => api.invitations.accept(token),
    onSuccess: joined,
    onError: (e) => setError(errorMessage(e)),
  });
  const signup = useMutation({
    mutationFn: (body: { name: string; password: string }) => api.invitations.signup(token, body),
    onSuccess: async (r) => {
      queryClient.clear();
      if (r.status !== "mfa_required") queryClient.setQueryData(qk.me, r.me);
      await navigate({ to: "/mfa/setup" });
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const sso = useMutation({
    mutationFn: (providerId: string) => api.auth.ssoStart({ providerId, redirect: here }),
    onSuccess: ({ url }) => window.location.assign(url),
    onError: (e) => setError(errorMessage(e)),
  });
  const signOut = useMutation({
    mutationFn: api.auth.logout,
    onSettled: () => {
      queryClient.clear();
      void me.refetch();
    },
  });

  if (preview.isPending || me.isPending) return <Skeleton className="h-64 rounded-lg" />;
  if (preview.isError) {
    return (
      <>
        <AuthHeading
          title="Invitation not found"
          description="The link may be incomplete, or it was replaced by a newer one."
        />
        <Link to="/login" className="text-sm font-medium text-accent-text hover:underline">
          Go to sign in
        </Link>
      </>
    );
  }
  const p = preview.data;
  const step = inviteStep(p, me.data ?? null);
  const title = `Join ${p.organization.name}`;
  const description = (
    <>
      {p.invitedBy ?? "Someone"} invited <strong className="text-ink">{p.email}</strong> as{" "}
      {ROLE_LABEL[p.role].toLowerCase()}.
    </>
  );

  const submitSignup = (e: FormEvent) => {
    e.preventDefault();
    const parsed = acceptInvitationSignupBody.safeParse({ name: name.trim(), password });
    if (!parsed.success) return setError("Enter your name and a password of at least 12 characters.");
    setError(null);
    signup.mutate(parsed.data);
  };

  return (
    <>
      <AuthHeading title={title} description={description} />
      <div className="flex flex-col gap-4">
        {error && <FormAlert>{error}</FormAlert>}
        {step.kind === "closed" && (
          <>
            <FormAlert>{CLOSED[step.status]}</FormAlert>
            <Link to="/login" className="text-sm font-medium text-accent-text hover:underline">
              Go to sign in
            </Link>
          </>
        )}
        {step.kind === "accept" && (
          <Button
            variant="primary"
            size="lg"
            leadingIcon={<Building2 />}
            loading={accept.isPending}
            onClick={() => accept.mutate()}
          >
            Join {p.organization.name}
          </Button>
        )}
        {step.kind === "finish_mfa" && (
          <>
            <p className="text-sm text-ink-muted">Finish two-factor sign-in first, then come back to this link.</p>
            <Button
              variant="primary"
              onClick={() =>
                step.to === "/mfa"
                  ? navigate({ to: "/mfa", search: { redirect: here } })
                  : navigate({ to: "/mfa/setup" })
              }
            >
              Continue
            </Button>
          </>
        )}
        {step.kind === "wrong_account" && (
          <>
            <p className="text-sm text-ink-muted">
              You're signed in as {step.signedInAs}. This invitation is for {p.email}.
            </p>
            <Button loading={signOut.isPending} onClick={() => signOut.mutate()}>
              Sign out and continue
            </Button>
          </>
        )}
        {(step.kind === "sign_in" || step.kind === "sign_up") && step.sso && (
          <Button
            variant={step.passwordAllowed ? "secondary" : "primary"}
            size="lg"
            loading={sso.isPending}
            onClick={() => step.sso && sso.mutate(step.sso.providerId)}
          >
            Continue with single sign-on
          </Button>
        )}
        {step.kind === "sign_in" && step.passwordAllowed && (
          <Button
            variant="primary"
            size="lg"
            trailingIcon={<ArrowRight />}
            onClick={() => navigate({ to: "/login", search: { redirect: here } })}
          >
            Sign in to accept
          </Button>
        )}
        {step.kind === "sign_up" && step.passwordAllowed && (
          <form onSubmit={submitSignup} noValidate className="flex flex-col gap-4">
            <Field label="Email">
              <Input value={p.email} disabled readOnly />
            </Field>
            <Field label="Your name">
              <Input autoComplete="name" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Password">
              <Input
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-describedby="invite-password-strength"
              />
            </Field>
            <PasswordHint password={password} id="invite-password-strength" />
            <Button type="submit" variant="primary" size="lg" loading={signup.isPending} trailingIcon={<ArrowRight />}>
              Create account and join
            </Button>
          </form>
        )}
        {step.kind !== "closed" && (
          <p className="text-xs text-ink-muted">
            This link works once and expires {new Date(p.expiresAt).toLocaleDateString()}.
          </p>
        )}
      </div>
    </>
  );
}
