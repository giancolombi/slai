import { type NotificationChannel, notificationChannelBody, type Risk } from "@slai/shared";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  cn,
  Dialog,
  EmptyState,
  Field,
  IconButton,
  Input,
  RISK_META,
  RiskBadge,
  Select,
  Skeleton,
  SkeletonRows,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  type ThemePreference,
  toast,
  useTheme,
} from "@slai/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Bell, Hash, KeyRound, Mail, Monitor, Moon, ShieldCheck, Sun, Trash2 } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { ErrorState, Page } from "../../components/page";
import { api, errorMessage } from "../../lib/api";
import { qk, useChannels, useMe, useOrg } from "../../lib/queries";

type Tab = "organization" | "security" | "notifications" | "appearance";
const TABS: Tab[] = ["organization", "security", "notifications", "appearance"];
type MinRisk = Exclude<Risk, "ok">;
const MIN_RISKS: MinRisk[] = ["warning", "at_risk", "breached"];

const riskOptions = MIN_RISKS.map((r) => {
  const Icon = RISK_META[r].icon;
  return {
    value: r,
    textValue: RISK_META[r].label,
    icon: <Icon className={RISK_META[r].text} aria-hidden />,
    label: `${RISK_META[r].label} or worse`,
  };
});

// ---------------------------------------------------------------- organization

function OrganizationTab({ canEdit }: { canEdit: boolean }) {
  const org = useOrg();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [requireMfa, setRequireMfa] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (org.data) {
      setName(org.data.name);
      setRequireMfa(org.data.requireMfa);
    }
  }, [org.data]);

  const save = useMutation({
    mutationFn: api.org.update,
    onSuccess: (next) => {
      queryClient.setQueryData(qk.org, next);
      void queryClient.invalidateQueries({ queryKey: qk.me });
      toast({ tone: "success", title: "Organization saved" });
    },
    onError: (e) => toast({ tone: "error", title: "Couldn't save", description: errorMessage(e) }),
  });

  if (org.isPending) return <Skeleton className="h-64 rounded-lg" />;
  if (org.isError)
    return <ErrorState error={org.error} resource="organization settings" onRetry={() => org.refetch()} />;

  const dirty = name.trim() !== org.data.name || requireMfa !== org.data.requireMfa;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setError("Enter a name.");
    setError(null);
    save.mutate({ name: name.trim(), requireMfa });
  };

  return (
    <Card>
      <form onSubmit={submit} noValidate>
        <CardHeader
          title="Organization"
          description={canEdit ? "Visible to everyone in your organization." : "Only admins can change these settings."}
        />
        <CardContent className="flex flex-col gap-5">
          <Field label="Name" error={error ?? undefined} className="max-w-md">
            <Input value={name} onChange={(e) => setName(e.target.value)} disabled={!canEdit} />
          </Field>
          <Field
            inline
            label="Require two-factor for everyone"
            hint="Members without two-factor are asked to set it up at their next sign-in."
          >
            <Switch checked={requireMfa} onCheckedChange={setRequireMfa} disabled={!canEdit} />
          </Field>
          <div className="flex items-center gap-2 text-xs text-ink-muted">
            <span>Plan</span>
            <Badge tone="accent" size="sm" className="capitalize">
              {org.data.plan}
            </Badge>
            <Link to="/usage" className="font-medium text-accent-text hover:underline">
              Usage & billing
            </Link>
          </div>
        </CardContent>
        {canEdit && (
          <CardFooter>
            <Button
              variant="ghost"
              disabled={!dirty}
              onClick={() => {
                setName(org.data.name);
                setRequireMfa(org.data.requireMfa);
              }}
            >
              Discard
            </Button>
            <Button type="submit" variant="primary" disabled={!dirty} loading={save.isPending}>
              Save changes
            </Button>
          </CardFooter>
        )}
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------- security

function SecurityTab() {
  const { data: me } = useMe();
  const org = useOrg();
  if (!me) return <Skeleton className="h-40 rounded-lg" />;
  const on = me.user.mfaEnabled;
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title="Two-factor authentication" description={`For ${me.user.email}`} />
        <CardContent className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span
              className={cn(
                "flex size-10 items-center justify-center rounded-lg border",
                on
                  ? "border-ok-border bg-ok-subtle text-ok-text"
                  : "border-warning-border bg-warning-subtle text-warning-text",
              )}
            >
              {on ? <ShieldCheck className="size-5" aria-hidden /> : <KeyRound className="size-5" aria-hidden />}
            </span>
            <div>
              <p className="text-sm font-medium text-ink">
                {on ? "On: a code from your authenticator app is required at sign-in." : "Off"}
              </p>
              <p className="text-xs text-ink-muted">
                {on
                  ? "To move to a new device, set it up again; the old key stops working."
                  : org.data?.requireMfa
                    ? "Your organization requires two-factor. Set it up now."
                    : "Protect approvals and policy changes with a second factor."}
              </p>
            </div>
          </div>
          <Button asChild variant={on ? "secondary" : "primary"}>
            <Link to="/mfa/setup">{on ? "Set up on a new device" : "Set up two-factor"}</Link>
          </Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader title="Sessions" />
        <CardContent className="text-sm text-ink-muted">
          Sessions use a secure, http-only cookie and expire after 12 hours of inactivity. Signing out ends this session
          only. Sign-ins are recorded in the{" "}
          <Link to="/audit" className="font-medium text-accent-text hover:underline">
            audit log
          </Link>
          .
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- notifications

function AddChannelDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<NotificationChannel["kind"]>("email");
  const [target, setTarget] = useState("");
  const [minRisk, setMinRisk] = useState<MinRisk>("at_risk");
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: api.notifications.create,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.channels });
      toast({ tone: "success", title: "Channel added" });
      setTarget("");
      onOpenChange(false);
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const value = target.trim();
    const parsed = notificationChannelBody.safeParse({ kind, target: value, minRisk, enabled: true });
    if (!parsed.success) return setError("Enter a destination.");
    if (kind === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return setError("Enter a valid email address.");
    if (kind === "slack_webhook" && !/^https:\/\/hooks\.slack\.com\//.test(value))
      return setError("Paste a Slack incoming webhook URL (https://hooks.slack.com/…).");
    setError(null);
    create.mutate(parsed.data);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add notification channel"
      description="slai alerts this channel when a ticket crosses the risk level you choose."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="channel-form" loading={create.isPending}>
            Add channel
          </Button>
        </>
      }
    >
      <form id="channel-form" onSubmit={submit} noValidate className="flex flex-col gap-4">
        <Field label="Type">
          <Select
            value={kind}
            onValueChange={(v) => {
              setKind(v as NotificationChannel["kind"]);
              setError(null);
            }}
            options={[
              { value: "email", label: "Email", icon: <Mail aria-hidden /> },
              { value: "slack_webhook", label: "Slack webhook", icon: <Hash aria-hidden /> },
            ]}
          />
        </Field>
        <Field label={kind === "email" ? "Email address" : "Webhook URL"} error={error ?? undefined}>
          <Input
            type={kind === "email" ? "email" : "url"}
            placeholder={kind === "email" ? "support-leads@company.com" : "https://hooks.slack.com/services/…"}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          />
        </Field>
        <Field label="Alert at" hint="Tickets that reach this risk level or worse trigger an alert.">
          <Select value={minRisk} onValueChange={(v) => setMinRisk(v as MinRisk)} options={riskOptions} />
        </Field>
      </form>
    </Dialog>
  );
}

function maskTarget(c: NotificationChannel) {
  if (c.kind === "slack_webhook") return c.target.replace(/\/[^/]+$/, "/••••••••");
  return c.target;
}

function NotificationsTab({ canEdit }: { canEdit: boolean }) {
  const channels = useChannels();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<Pick<NotificationChannel, "enabled" | "minRisk">> }) =>
      api.notifications.update(id, body),
    onMutate: async ({ id, body }) => {
      await queryClient.cancelQueries({ queryKey: qk.channels });
      const prev = queryClient.getQueryData<NotificationChannel[]>(qk.channels);
      queryClient.setQueryData<NotificationChannel[]>(qk.channels, (list) =>
        list?.map((c) => (c.id === id ? { ...c, ...body } : c)),
      );
      return { prev };
    },
    onError: (e, _, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(qk.channels, ctx.prev);
      toast({ tone: "error", title: "Couldn't update channel", description: errorMessage(e) });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: qk.channels }),
  });
  const remove = useMutation({
    mutationFn: api.notifications.remove,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.channels });
      toast({ tone: "success", title: "Channel removed" });
    },
    onError: (e) => toast({ tone: "error", title: "Couldn't remove channel", description: errorMessage(e) }),
  });

  return (
    <Card>
      <CardHeader
        title="Notification channels"
        description="Where slai sends risk alerts. In-app alerts are always on."
        actions={
          canEdit && (
            <Button size="sm" variant="primary" leadingIcon={<Bell />} onClick={() => setAdding(true)}>
              Add channel
            </Button>
          )
        }
      />
      {channels.isPending ? (
        <SkeletonRows rows={3} className="px-5 pb-5" label="Loading channels" />
      ) : channels.isError ? (
        <ErrorState error={channels.error} resource="channels" onRetry={() => channels.refetch()} compact />
      ) : channels.data.length === 0 ? (
        <EmptyState
          compact
          icon={<Bell />}
          title="No channels yet"
          description="Add an email address or a Slack webhook to hear about risk before it becomes a breach."
          action={
            canEdit && (
              <Button size="sm" onClick={() => setAdding(true)}>
                Add channel
              </Button>
            )
          }
        />
      ) : (
        <ul className="divide-y divide-line border-t border-line">
          {channels.data.map((c) => {
            const Icon = c.kind === "email" ? Mail : Hash;
            return (
              <li key={c.id} className="flex flex-wrap items-center gap-x-4 gap-y-3 px-5 py-3.5">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-md border border-line bg-sunken text-ink-muted">
                  <Icon className="size-4" aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <p className={cn("truncate text-sm font-medium", c.enabled ? "text-ink" : "text-ink-muted")}>
                    {maskTarget(c)}
                  </p>
                  <p className="text-xs text-ink-muted">{c.kind === "email" ? "Email" : "Slack webhook"}</p>
                </div>
                {canEdit ? (
                  <div className="w-48 shrink-0">
                    <Select
                      size="sm"
                      aria-label={`Alert level for ${c.target}`}
                      value={c.minRisk}
                      onValueChange={(v) => update.mutate({ id: c.id, body: { minRisk: v as MinRisk } })}
                      options={riskOptions}
                    />
                  </div>
                ) : (
                  <span className="flex items-center gap-1.5 text-xs text-ink-muted">
                    <RiskBadge risk={c.minRisk} size="sm" /> or worse
                  </span>
                )}
                <Switch
                  aria-label={`${c.enabled ? "Disable" : "Enable"} ${c.target}`}
                  checked={c.enabled}
                  disabled={!canEdit}
                  onCheckedChange={(enabled) => update.mutate({ id: c.id, body: { enabled } })}
                />
                {canEdit && (
                  <IconButton
                    size="sm"
                    label={`Remove ${c.target}`}
                    icon={<Trash2 />}
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(c.id)}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
      {adding && <AddChannelDialog open={adding} onOpenChange={setAdding} />}
    </Card>
  );
}

// ---------------------------------------------------------------- appearance

const THEMES: { value: ThemePreference; label: string; icon: typeof Sun; swatch: string[] }[] = [
  { value: "light", label: "Light", icon: Sun, swatch: ["#f6f7f9", "#ffffff", "#4a4ad8"] },
  { value: "dark", label: "Dark", icon: Moon, swatch: ["#0e1014", "#16181d", "#7b7ff5"] },
  { value: "system", label: "System", icon: Monitor, swatch: ["#f6f7f9", "#0e1014", "#5a5de6"] },
];

function AppearanceTab() {
  const { preference, setPreference } = useTheme();
  return (
    <Card>
      <CardHeader title="Theme" description="Saved on this device." />
      <CardContent>
        <fieldset>
          <legend className="sr-only">Theme</legend>
          <div className="grid gap-3 sm:grid-cols-3">
            {THEMES.map((t) => {
              const Icon = t.icon;
              const checked = preference === t.value;
              return (
                <label
                  key={t.value}
                  className={cn(
                    "relative flex cursor-pointer flex-col gap-3 rounded-lg border p-3 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-focus",
                    checked ? "border-accent bg-accent-subtle/40" : "border-line hover:border-line-strong",
                  )}
                >
                  <input
                    type="radio"
                    name="theme"
                    value={t.value}
                    checked={checked}
                    onChange={() => setPreference(t.value)}
                    className="sr-only"
                  />
                  <span
                    aria-hidden
                    className="flex h-16 overflow-hidden rounded-md border border-line"
                    style={{ background: t.swatch[0] }}
                  >
                    <span className="m-2 flex-1 rounded-sm" style={{ background: t.swatch[1] }}>
                      <span className="m-2 block h-1.5 w-8 rounded-full" style={{ background: t.swatch[2] }} />
                    </span>
                  </span>
                  <span className="flex items-center gap-2 text-sm font-medium text-ink">
                    <Icon className="size-4 text-ink-muted" aria-hidden />
                    {t.label}
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------- page

function initialTab(): Tab {
  const h = typeof window !== "undefined" ? window.location.hash.slice(1) : "";
  return TABS.includes(h as Tab) ? (h as Tab) : "organization";
}

export function SettingsPage() {
  const { data: me } = useMe();
  const [tab, setTab] = useState<Tab>(initialTab);
  const canEdit = me?.role === "owner" || me?.role === "admin";
  const onTab = (v: string) => {
    setTab(v as Tab);
    history.replaceState(history.state, "", `#${v}`);
  };
  return (
    <Page title="Settings" width="narrow">
      <Tabs value={tab} onValueChange={onTab}>
        <TabsList aria-label="Settings sections">
          <TabsTrigger value="organization">Organization</TabsTrigger>
          <TabsTrigger value="security">Security</TabsTrigger>
          <TabsTrigger value="notifications">Notifications</TabsTrigger>
          <TabsTrigger value="appearance">Appearance</TabsTrigger>
        </TabsList>
        <TabsContent value="organization" className="pt-5">
          <OrganizationTab canEdit={canEdit} />
        </TabsContent>
        <TabsContent value="security" className="pt-5">
          <SecurityTab />
        </TabsContent>
        <TabsContent value="notifications" className="pt-5">
          <NotificationsTab canEdit={canEdit} />
        </TabsContent>
        <TabsContent value="appearance" className="pt-5">
          <AppearanceTab />
        </TabsContent>
      </Tabs>
    </Page>
  );
}
