import { inviteBody, type Member, ROLES, type Role } from "@slai/shared";
import {
  Avatar,
  Badge,
  Button,
  Card,
  Dialog,
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
  TH,
  THead,
  TR,
  toast,
} from "@slai/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ShieldAlert, ShieldCheck, Trash2, UserPlus, Users } from "lucide-react";
import { type FormEvent, useState } from "react";
import { ErrorState, Page } from "../../components/page";
import { api, errorMessage } from "../../lib/api";
import { ROLE_HELP, ROLE_LABEL } from "../../lib/labels";
import { qk, useMe, useMembers } from "../../lib/queries";

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

export function TeamPage() {
  const members = useMembers();
  const { data: me } = useMe();
  const queryClient = useQueryClient();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [removing, setRemoving] = useState<Member | null>(null);
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
                          {isAdmin && m.role !== "owner" && !self && (
                            <IconButton
                              size="sm"
                              label={`Remove ${m.name}`}
                              icon={<Trash2 />}
                              onClick={() => setRemoving(m)}
                            />
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
      <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} />
      <RemoveDialog member={removing} onClose={() => setRemoving(null)} />
    </Page>
  );
}
