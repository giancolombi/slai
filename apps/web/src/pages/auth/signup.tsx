import { signupBody } from "@slai/shared";
import { Button, cn, Field, Input } from "@slai/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowRight, Check } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { api, errorMessage, isApiError } from "../../lib/api";
import { qk } from "../../lib/queries";
import { AuthHeading, FormAlert } from "./auth-layout";
import { apiFieldErrors, type FieldErrors, zodFieldErrors } from "./form-errors";

interface Requirement {
  label: string;
  ok: (p: string) => boolean;
}

const REQUIREMENTS: Requirement[] = [
  { label: "At least 12 characters", ok: (p) => p.length >= 12 },
  { label: "Upper and lower case letters", ok: (p) => /[a-z]/.test(p) && /[A-Z]/.test(p) },
  { label: "A number or symbol", ok: (p) => /[\d\W_]/.test(p) },
];

function strength(p: string): { score: number; label: string } {
  if (!p) return { score: 0, label: "" };
  let score = REQUIREMENTS.filter((r) => r.ok(p)).length;
  if (p.length >= 16) score++;
  // Under the minimum length nothing else matters.
  if (p.length < 12) score = Math.min(score, 1);
  const label = ["Too short", "Weak", "Fair", "Good", "Strong"][Math.min(score, 4)]!;
  return { score, label };
}

function PasswordHint({ password, id }: { password: string; id: string }) {
  const s = strength(password);
  return (
    <div id={id} className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <div className="grid flex-1 grid-cols-4 gap-1" aria-hidden>
          {[1, 2, 3, 4].map((i) => (
            <span
              key={i}
              className={cn(
                "h-1 rounded-full transition-colors",
                s.score >= i ? (s.score >= 3 ? "bg-ok" : s.score === 2 ? "bg-warning" : "bg-breached") : "bg-sunken",
              )}
            />
          ))}
        </div>
        <span className="w-16 text-right text-2xs font-medium text-ink-muted" aria-live="polite">
          {s.label}
        </span>
      </div>
      <ul className="flex flex-col gap-0.5">
        {REQUIREMENTS.map((r) => {
          const ok = r.ok(password);
          return (
            <li
              key={r.label}
              className={cn("flex items-center gap-1.5 text-xs", ok ? "text-ok-text" : "text-ink-muted")}
            >
              <Check className={cn("size-3", !ok && "opacity-30")} aria-hidden />
              {r.label}
              <span className="sr-only">{ok ? "(met)" : "(not met)"}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function SignupPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [values, setValues] = useState({ name: "", email: "", password: "", organizationName: "" });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    document.title = "Create your account · slai";
  }, []);

  const set = (k: keyof typeof values) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setValues((v) => ({ ...v, [k]: e.target.value }));

  const signup = useMutation({
    mutationFn: api.auth.signup,
    onSuccess: async (result) => {
      queryClient.clear();
      if (result.status !== "mfa_required") queryClient.setQueryData(qk.me, result.me);
      // Every new account enrolls a second factor before anything else.
      await navigate({ to: "/mfa/setup" });
    },
    onError: (e) => {
      if (isApiError(e) && (e.code === "email_taken" || e.code === "signup_failed")) {
        setErrors({ email: "An account with this email already exists." });
        return;
      }
      const fields = apiFieldErrors(e);
      if (Object.keys(fields).length) setErrors(fields);
      else setFormError(errorMessage(e));
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const parsed = signupBody.safeParse({
      name: values.name.trim(),
      email: values.email.trim(),
      password: values.password,
      organizationName: values.organizationName.trim(),
    });
    if (!parsed.success) {
      const fe = zodFieldErrors(parsed.error);
      setErrors({
        ...(fe.name && { name: "Enter your name." }),
        ...(fe.email && { email: "Enter a valid work email." }),
        ...(fe.password && { password: "Use at least 12 characters." }),
        ...(fe.organizationName && { organizationName: "Enter your company's name." }),
      });
      return;
    }
    setErrors({});
    signup.mutate(parsed.data);
  };

  return (
    <>
      <AuthHeading
        title="Create your account"
        description="Start with a free 90-day Breach Replay. No card, read-only access to your help desk."
      />
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        {formError && <FormAlert>{formError}</FormAlert>}
        <Field label="Your name" error={errors.name}>
          <Input autoComplete="name" autoFocus value={values.name} onChange={set("name")} />
        </Field>
        <Field label="Work email" error={errors.email}>
          <Input
            type="email"
            autoComplete="email"
            value={values.email}
            onChange={set("email")}
            placeholder="you@company.com"
          />
        </Field>
        <Field label="Password" error={errors.password}>
          <Input
            type="password"
            autoComplete="new-password"
            value={values.password}
            onChange={set("password")}
            aria-describedby={errors.password ? undefined : "password-strength"}
          />
        </Field>
        <PasswordHint password={values.password} id="password-strength" />
        <Field
          label="Company"
          hint="Becomes your organization. You can rename it later."
          error={errors.organizationName}
        >
          <Input autoComplete="organization" value={values.organizationName} onChange={set("organizationName")} />
        </Field>
        <Button
          type="submit"
          variant="primary"
          size="lg"
          loading={signup.isPending}
          trailingIcon={<ArrowRight />}
          className="mt-2"
        >
          Create account
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-ink-muted">
        Already have an account?{" "}
        <Link to="/login" className="font-medium text-accent-text hover:underline">
          Sign in
        </Link>
      </p>
    </>
  );
}
