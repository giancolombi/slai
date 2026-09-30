import type { Role } from "@slai/shared";
import { Button, Dialog, Kbd } from "@slai/ui";
import { useNavigate } from "@tanstack/react-router";
import { Eye, FileSignature, Gauge, Inbox, ListChecks, Ticket } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useMe, useOnboarding, useUpdateOnboarding } from "../lib/queries";

interface Content {
  title: string;
  intro: string;
  points: { icon: ReactNode; text: string }[];
  primary: { label: string; to: string };
  secondary?: { label: string; to: string };
}

/** What the welcome says, by role: admins set things up; members work tickets and approvals; viewers look. */
export function welcomeContent(role: Role, firstName: string, orgName: string): Content {
  if (role === "owner" || role === "admin") {
    return {
      title: `Welcome to slai, ${firstName}`,
      intro:
        "slai runs every ticket on the SLA clock your contracts promise and warns you before a breach. Setting it up takes about five minutes.",
      points: [
        {
          icon: <ListChecks />,
          text: "The checklist on your dashboard shows each step and ticks it off as it really happens.",
        },
        { icon: <FileSignature />, text: "Start by connecting your help desk and uploading a contract." },
      ],
      primary: { label: "Show me the checklist", to: "/" },
      secondary: { label: "Guided setup", to: "/onboarding" },
    };
  }
  if (role === "member") {
    return {
      title: `Welcome to ${orgName}, ${firstName}`,
      intro: "Here is what you'll do in slai:",
      points: [
        {
          icon: <Ticket />,
          text: "Work the tickets closest to breaching first. Tickets are sorted by risk, with live clocks.",
        },
        {
          icon: <Inbox />,
          text: "Approve, edit or reject the replies agents drafted, in Approvals. Nothing reaches a customer until someone approves.",
        },
        { icon: <Gauge />, text: "Keep an eye on the dashboard: what's due soon and how the month is going." },
      ],
      primary: { label: "Open Approvals", to: "/approvals" },
      secondary: { label: "See the tickets", to: "/tickets" },
    };
  }
  return {
    title: `Welcome to ${orgName}, ${firstName}`,
    intro: "You have view-only access. You can see everything your organization sees, but not change it:",
    points: [
      { icon: <Gauge />, text: "The dashboard: tickets by risk, attainment, breaches and credits at stake." },
      { icon: <Ticket />, text: "Every ticket with its SLA clocks and timeline, and the approvals inbox." },
      { icon: <Eye />, text: "Breach Replay reports and billing. Ask an admin if you need to do more." },
    ],
    primary: { label: "Explore the dashboard", to: "/" },
  };
}

/**
 * First-run welcome: shown once per user per organization (after two-factor setup, since the
 * app shell needs a complete sign-in), and marked seen server-side however it is closed.
 */
export function WelcomeDialog() {
  const me = useMe();
  const onboarding = useOnboarding();
  const update = useUpdateOnboarding();
  const navigate = useNavigate();
  const [closed, setClosed] = useState(false);
  if (!me.data || !onboarding.data || onboarding.data.welcomeSeen || closed) return null;

  const firstName = me.data.user.name.split(" ")[0] ?? me.data.user.name;
  const c = welcomeContent(me.data.role, firstName, me.data.organization.name);
  const finish = (to?: string) => {
    setClosed(true);
    update.mutate({ welcomeSeen: true });
    if (to) void navigate({ to });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && finish()}
      title={c.title}
      description={c.intro}
      footer={
        <>
          {c.secondary && (
            <Button variant="secondary" onClick={() => finish(c.secondary!.to)}>
              {c.secondary.label}
            </Button>
          )}
          <Button variant="primary" onClick={() => finish(c.primary.to)}>
            {c.primary.label}
          </Button>
        </>
      }
    >
      <ul className="flex flex-col gap-3">
        {c.points.map((p) => (
          <li key={p.text} className="flex gap-3 text-sm text-ink">
            <span
              className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border border-line bg-sunken text-ink-muted [&_svg]:size-4"
              aria-hidden
            >
              {p.icon}
            </span>
            <span className="leading-relaxed">{p.text}</span>
          </li>
        ))}
      </ul>
      <p className="mt-4 text-xs text-ink-muted">
        Press <Kbd>?</Kbd> any time to open Help, or use "About this page" in the top bar.
      </p>
    </Dialog>
  );
}
