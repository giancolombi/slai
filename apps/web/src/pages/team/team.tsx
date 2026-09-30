import { inviteBody, type Member, ROLES, type Role, resetMemberMfaBody } from "@slai/shared";
import {
  Avatar,
  Badge,
  Button,
  Card,
  Dialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  Field,
  formatRelative,
  IconButton,
  Input,
  Select,
  SkeletonRows,
  Table,
  TableMessage,
  TBody,
  TD,
  Textarea,
  TH,
  THead,
  TR,
  toast,
} from "@slai/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Mail, MoreHorizontal, ShieldAlert, ShieldCheck, Trash2, UserPlus, Users } from "lucide-react";
import { type FormEvent, useState } from "react";
import { ErrorState, Page } from "../../components/page";
import { StepUp } from "../../components/step-up";
import { api, errorMessage, isApiError } from "../../lib/api";
import { canResetMfa, stepUpFresh } from "../../lib/auth-flow";
import { ROLE_HELP, ROLE_LABEL } from "../../lib/labels";
import { qk, useInvitations, useMe, useMembers } from "../../lib/queries";

const ASSIGNABLE: Role[] = ROLES.filter((r) => r !== "owner");

// Plain labels: Radix renders the selected item's text inside the trigger.
const roleOptions = (roles: readonly Role[]) => roles.map((r) => ({ value: r, label: ROLE_LABEL[r] }));

function InviteDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [error, setError] = useState<string | null>(null);
  const invite = useMutation({
    mutationFn: api.members.invite,
    onSuccess: (m) => {
      void queryClient.invalidateQueries({ queryKey: qk.members });
      toast({
        tone: "success",
        title: "Invitation sent",
        description: `${m.email} joins as ${ROLE_LABEL[m.role].toLowerCase()}.`,
      });
      setEmail("");
      onOpenChange(false);
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = inviteBody.safeParse({ email: email.trim(), role });
    if (!parsed.success) return setError("Enter a valid email address.");
    setError(null);
    invite.mutate(parsed.data);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Invite a teammate"
      description="They'll get an email with a link to join your organization."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="invite-form" loading={invite.isPending}>
            Send invite
          </Button>
        </>
      }
    >
      <form id="invite-form" onSubmit={submit} noValidate className="flex flex-col gap-4">
        <Field label="Email" error={error ?? undefined}>
          <Input
            type="email"
            autoComplete="off"
            placeholder="name@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label="Role" hint={ROLE_HELP[role]}>
          <Select value={role} onValueChange={(v) => setRole(v as Role)} options={roleOptions(ASSIGNABLE)} />
        </Field>
      </form>
    </Dialog>
  );
}

function RemoveDialog({ member, onClose }: { member: Member | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: (m: Member) => api.members.remove(m.userId),
    onSuccess: (_, m) => {
      void queryClient.invalidateQueries({ queryKey: qk.members });
      toast({ tone: "success", title: `${m.name} was removed` });
      onClose();
    },
    onError: (e) => toast({ tone: "error", title: "Couldn't remove member", description: errorMessage(e) }),
  });
  return (
    <Dialog
      open={member !== null}
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title={`Remove ${member?.name ?? "member"}?`}
      description="They lose access immediately. Their past approvals stay in the audit log."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" loading={remove.isPending} onClick={() => member && remove.mutate(member)}>
            Remove
          </Button>
        </>
      }
    />
  );
}

/**
 * Reset a member's second factors (T-19): a reason for the audit log and a fresh
 * step-up (TOTP or passkey in the last 5 minutes). The member is signed out
 * everywhere, emailed, and enrolls again at their next sign-in.
 */
function ResetMfaDialog({ member, onClose }: { member: Member | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { data: me } = useMe();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    setReason("");
    setError(null);
    onClose();
  };
  const reset = useMutation({
    mutationFn: (m: Member) => api.members.resetMfa(m.userId, reason.trim()),
    onSuccess: (r, m) => {
      void queryClient.invalidateQueries({ queryKey: qk.members });
      toast({
        tone: "success",
        title: `Two-factor reset for ${m.name}`,
        description: `Removed ${[r.removed.totp && "their authenticator app and backup codes", r.removed.passkeys > 0 && `${r.removed.passkeys} passkey${r.removed.passkeys === 1 ? "" : "s"}`].filter(Boolean).join(" and ") || "no factors"}; signed out of ${r.sessionsRevoked} session${r.sessionsRevoked === 1 ? "" : "s"}. They've been emailed.`,
      });
      close();
    },
    onError: (e) => {
      // The proof expired meanwhile: show the step-up prompt again.
      if (isApiError(e) && e.code === "step_up_required") void queryClient.invalidateQueries({ queryKey: qk.me });
      setError(errorMessage(e));
    },
  });
  const reasonOk = resetMemberMfaBody.safeParse({ reason }).success;
  const fresh = me ? stepUpFresh(me) : false;
  return (
    <Dialog
      open={member !== null}
      onOpenChange={(o) => !o && close()}
      title={`Reset two-factor for ${member?.name ?? "member"}?`}
      description="Their authenticator app, backup codes and passkeys are removed and they're signed out everywhere. They set up two-factor again at their next sign-in, and get an email about it. Only do this after checking it's really them."
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={!reasonOk || !fresh}
            loading={reset.isPending}
            onClick={() => member && reset.mutate(member)}
          >
            Reset two-factor
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field
          label="Reason"
          hint="How you verified their identity (a ticket, a call). Recorded in the audit log."
          error={error ?? undefined}
        >
          <Textarea
            rows={3}
            value={reason}
            maxLength={500}
            placeholder="HELP-123: lost phone; verified on a video call"
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
        {me && !fresh && <StepUp me={me} onVerified={() => setError(null)} />}
      </div>
    </Dialog>
  );
}

/** Invitations that have not been accepted yet (T-59a): resend (a new link, 7 more days) or revoke. */
function PendingInvitations() {
  const invitations = useInvitations();
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: qk.invitations });
  const resend = useMutation({
    mutationFn: api.members.resendInvitation,
    onSuccess: (inv) => {
      void refresh();
      toast({ tone: "success", title: "Invitation sent again", description: `A new link went to ${inv.email}.` });
    },
    onError: (e) => toast({ tone: "error", title: "Couldn't resend", description: errorMessage(e) }),
  });
  const revoke = useMutation({
    mutationFn: api.members.revokeInvitation,
    onSuccess: () => {
      void refresh();
      toast({ tone: "success", title: "Invitation revoked" });
    },
    onError: (e) => toast({ tone: "error", title: "Couldn't revoke", description: errorMessage(e) }),
  });
  const open = (invitations.data?.items ?? []).filter((i) => i.status === "pending" || i.status === "expired");
  if (open.length === 0) return null;
  return (
    <Card>
      <Table aria-label="Pending invitations">
        <THead>
          <tr>
            <TH>Invited</TH>
            <TH className="w-56">Role</TH>
            <TH>Status</TH>
            <TH className="w-48">
              <span className="sr-only">Actions</span>
            </TH>
          </tr>
        </THead>
        <TBody>
          {open.map((i) => (
            <TR key={i.id}>
              <TD>
                <div className="flex items-center gap-3">
                  <Mail className="size-4 text-ink-muted" aria-hidden />
                  <div className="min-w-0">
                    <div className="truncate font-medium text-ink">{i.email}</div>
                    <div className="truncate text-xs text-ink-muted">
                      {i.invitedBy ? `by ${i.invitedBy}, ` : ""}
                      {formatRelative(i.createdAt)}
                    </div>
                  </div>
                </div>
              </TD>
              <TD className="text-sm text-ink">{ROLE_LABEL[i.role]}</TD>
              <TD>
                {i.status === "pending" ? (
                  <Badge tone="outline" size="sm">
                    Expires {formatRelative(i.expiresAt)}
                  </Badge>
                ) : (
                  <Badge tone="warning" size="sm">
                    Expired
                  </Badge>
                )}
              </TD>
              <TD>
                <div className="flex justify-end gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={resend.isPending && resend.variables === i.id}
                    onClick={() => resend.mutate(i.id)}
                  >
                    Resend
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={revoke.isPending && revoke.variables === i.id}
                    onClick={() => revoke.mutate(i.id)}
                  >
                    Revoke
                  </Button>
                </div>
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </Card>
  );
}

export function TeamPage() {
  const members = useMembers();
  const { data: me } = useMe();
  const queryClient = useQueryClient();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [removing, setRemoving] = useState<Member | null>(null);
  const [resetting, setResetting] = useState<Member | null>(null);
  const isOwner = me?.role === "owner";
  const isAdmin = isOwner || me?.role === "admin";

  const setRole = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: Role }) => api.members.setRole(userId, role),
    onSuccess: (m) => {
      void queryClient.invalidateQueries({ queryKey: qk.members });
      toast({ tone: "success", title: `${m.name} is now ${ROLE_LABEL[m.role].toLowerCase()}` });
    },
    onError: (e) => {
      void queryClient.invalidateQueries({ queryKey: qk.members });
      toast({ tone: "error", title: "Couldn't change role", description: errorMessage(e) });
    },
  });

  const items = members.data?.items ?? [];
  const withoutMfa = items.filter((m) => !m.mfaEnabled).length;

  return (
    <Page
      title="Team"
      description="Everyone who can see tickets, approve drafts or change policies. slai prices by tickets, not seats."
      actions={
        isAdmin && (
          <Button variant="primary" leadingIcon={<UserPlus />} onClick={() => setInviteOpen(true)}>
            Invite
          </Button>
        )
      }
    >
      <Card>
        {members.isError ? (
          <ErrorState error={members.error} resource="members" onRetry={() => members.refetch()} />
        ) : (
          <>
            {withoutMfa > 0 && (
              <div className="flex items-center gap-2 border-b border-line bg-warning-subtle/60 px-4 py-2.5 text-sm text-warning-text">
                <ShieldAlert className="size-4 shrink-0" aria-hidden />
                {withoutMfa === 1 ? "1 member hasn't" : `${withoutMfa} members haven't`} turned on two-factor yet.
              </div>
            )}
            <Table aria-label="Members">
              <THead>
                <tr>
                  <TH>Member</TH>
                  <TH className="w-56">Role</TH>
                  <TH>Two-factor</TH>
                  <TH className="hidden md:table-cell">Last sign-in</TH>
                  <TH className="w-12">
                    <span className="sr-only">Actions</span>
                  </TH>
                </tr>
              </THead>
              <TBody>
                {members.isPending ? (
                  <TableMessage colSpan={5}>
                    <SkeletonRows rows={6} className="p-4" label="Loading members" />
                  </TableMessage>
                ) : items.length === 0 ? (
                  <TableMessage colSpan={5}>
                    <EmptyState
                      icon={<Users />}
                      title="No members yet"
                      description="Invite your support leads and agents."
                    />
                  </TableMessage>
                ) : (
                  items.map((m) => {
                    const self = m.userId === me?.user.id;
                    return (
                      <TR key={m.userId}>
                        <TD>
                          <div className="flex items-center gap-3">
                            <Avatar name={m.name} size="md" />
                            <div className="min-w-0">
                              <div className="truncate font-medium text-ink">
                                {m.name}
                                {self && <span className="ml-1.5 text-xs font-normal text-ink-muted">(you)</span>}
                                {!m.active && (
                                  <Badge tone="outline" size="sm" className="ml-1.5">
                                    Deactivated
                                  </Badge>
                                )}
                                {m.scimManaged && (
                                  <Badge tone="outline" size="sm" className="ml-1.5">
                                    SCIM
                                  </Badge>
                                )}
                              </div>
                              <div className="truncate text-xs text-ink-muted">{m.email}</div>
                            </div>
                          </div>
                        </TD>
                        <TD>
                          {isOwner && m.role !== "owner" ? (
                            <div className="w-40">
                              <Select
                                size="sm"
                                aria-label={`Role for ${m.name}`}
                                value={m.role}
                                disabled={setRole.isPending}
                                onValueChange={(v) => setRole.mutate({ userId: m.userId, role: v as Role })}
                                options={roleOptions(ASSIGNABLE)}
                              />
                            </div>
                          ) : (
                            <span title={ROLE_HELP[m.role]} className="text-sm text-ink">
                              {ROLE_LABEL[m.role]}
                            </span>
                          )}
                        </TD>
                        <TD>
                          {m.mfaEnabled ? (
                            <Badge tone="ok" size="sm" icon={<ShieldCheck />}>
                              On
                            </Badge>
                          ) : (
                            <Badge tone="warning" size="sm" icon={<ShieldAlert />}>
                              Off
                            </Badge>
                          )}
                        </TD>
                        <TD className="hidden text-ink-muted md:table-cell">
                          {m.lastLoginAt ? (
                            <time dateTime={m.lastLoginAt}>{formatRelative(m.lastLoginAt)}</time>
                          ) : (
                            <Badge tone="outline" size="sm">
                              Invited
                            </Badge>
                          )}
                        </TD>
                        <TD>
                          {me && (canResetMfa(me, m) || (isAdmin && m.role !== "owner" && !self)) && (
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <IconButton size="sm" label={`Actions for ${m.name}`} icon={<MoreHorizontal />} />
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                {canResetMfa(me, m) && (
                                  <DropdownMenuItem onSelect={() => setResetting(m)}>
                                    <KeyRound aria-hidden /> Reset two-factor
                                  </DropdownMenuItem>
                                )}
                                {isAdmin && m.role !== "owner" && !self && (
                                  <>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem destructive onSelect={() => setRemoving(m)}>
                                      <Trash2 aria-hidden /> Remove
                                    </DropdownMenuItem>
                                  </>
                                )}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          )}
                        </TD>
                      </TR>
                    );
                  })
                )}
              </TBody>
            </Table>
          </>
        )}
      </Card>
      {isAdmin && <PendingInvitations />}
      <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} />
      <RemoveDialog member={removing} onClose={() => setRemoving(null)} />
      <ResetMfaDialog member={resetting} onClose={() => setResetting(null)} />
    </Page>
  );
}
