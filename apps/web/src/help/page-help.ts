import type { GuideId } from "./types";

export interface PageHelp {
  title: string;
  /** What the page is for, in a sentence or two. */
  purpose: string;
  /** What to do next here. */
  next: string[];
  guides: GuideId[];
}

/**
 * "About this page" content for every page in the app shell, keyed by route path.
 * A test fails if a routed page has no entry, so new pages can't ship without help.
 */
export const PAGE_HELP: Record<string, PageHelp> = {
  "/": {
    title: "Dashboard",
    purpose:
      "Where every contract stands right now: open tickets by risk, what is due soon, attainment, breaches and the credits at stake this month.",
    next: [
      "Work the at-risk queue before those tickets breach.",
      "Clear pending approvals so drafts reach customers in time.",
      "New here? Follow the getting-started checklist.",
    ],
    guides: ["getting-started", "sla-clock", "replay"],
  },
  "/tickets": {
    title: "Tickets",
    purpose: "Every ticket from your help desk on its contract's clock, most urgent first.",
    next: [
      "Filter by risk to see what is about to breach.",
      "Open a ticket to see each metric's clock, the timeline and the arithmetic.",
      "Press / anywhere to search tickets.",
    ],
    guides: ["sla-clock", "faq"],
  },
  "/tickets/$ticketId": {
    title: "Ticket",
    purpose:
      "One ticket's SLA clocks (one per metric), the policy that measures it, its event timeline, and what the agents did.",
    next: [
      "Check which metric is closest to its due time.",
      "Run triage or a draft by hand if you want help now.",
      "A metric shows — when there is nothing to measure it against.",
    ],
    guides: ["sla-clock", "autonomy", "faq"],
  },
  "/approvals": {
    title: "Approvals",
    purpose:
      "Drafts waiting for a person: written under Assist rules, or autopilot drafts a guardrail held back. Nothing here has reached a customer.",
    next: ["Approve, edit or reject each draft.", "Use j and k to move, a to approve, e to edit, r to reject."],
    guides: ["approvals", "autonomy", "knowledge"],
  },
  "/contracts": {
    title: "Contracts",
    purpose: "The SLA contracts you've signed. slai extracts a policy from each, with a citation for every number.",
    next: [
      "Upload an MSA, SLA schedule or order form.",
      "Open a contract marked Needs review to answer its questions and approve the policy.",
    ],
    guides: ["contract-review", "getting-started"],
  },
  "/contracts/$contractId": {
    title: "Contract review",
    purpose:
      "Check the policy slai extracted against the contract. Every value links to its citation; open questions must be answered before approval.",
    next: [
      "Confirm or change each open question.",
      "Select a field to see its quote in the document.",
      "Approve when every question is resolved (admins).",
    ],
    guides: ["contract-review", "sla-clock"],
  },
  "/policies": {
    title: "Policies",
    purpose:
      "Your machine-checkable SLA policies, versioned. Tickets are measured against their customer's active policy, or the default.",
    next: ["Make sure one active policy is the default.", "Preview a policy against your history before approving it."],
    guides: ["contract-review", "sla-clock"],
  },
  "/customers": {
    title: "Customers",
    purpose:
      "Your customers, how their tickets are matched (help-desk organization, then email domain), their monthly fee, and their policy.",
    next: [
      "Assign each customer the policy from their contract.",
      "Add the monthly fee so credit exposure can be priced.",
    ],
    guides: ["contract-review", "replay", "faq"],
  },
  "/connections": {
    title: "Connections",
    purpose: "The help desks slai reads tickets from and, within your autonomy rules, writes notes and replies to.",
    next: ["Connect your help desk.", "Set up webhooks so changes arrive instantly."],
    guides: ["connections", "getting-started"],
  },
  "/connections/$connectionId": {
    title: "Connection",
    purpose:
      "One help desk: its status and last sync, webhook setup, and how its statuses and priorities map to slai's.",
    next: ["Finish the webhook setup.", "Map any custom statuses, especially the ones that should pause clocks."],
    guides: ["connections", "sla-clock"],
  },
  "/autonomy": {
    title: "Autonomy",
    purpose:
      "How much agents may do, per customer and priority: observe, assist or autopilot. The SLA clock and alerts never depend on it.",
    next: [
      "Set the default rule, then override it for specific customers or priorities.",
      "Pick the trigger risk and, for autopilot, the minimum confidence.",
    ],
    guides: ["autonomy", "approvals", "knowledge"],
  },
  "/knowledge": {
    title: "Knowledge",
    purpose:
      "Help-center articles and saved replies that drafts may quote. Without them, drafts are unsure and autopilot holds them.",
    next: [
      "Sync your help center.",
      "Write saved replies for your most common answers.",
      "Switch off outdated articles.",
    ],
    guides: ["knowledge", "autonomy"],
  },
  "/replay": {
    title: "Breach Replay",
    purpose:
      "Replay past tickets against your approved policies: the breaches you had, what they cost in credits, and how early slai would have warned.",
    next: ["Run a 90-day replay on your connection.", "Share the report with finance or leadership."],
    guides: ["replay", "contract-review"],
  },
  "/replay/$replayId": {
    title: "Breach Replay report",
    purpose:
      "One replay's results: breaches, attainment, credit exposure by customer and metric, and the median warning.",
    next: ["Check the customers with the most exposure.", "Print or save it as a PDF."],
    guides: ["replay", "sla-clock"],
  },
  "/billing": {
    title: "Billing",
    purpose:
      "Your plan, tracked tickets against its limit, AI credits against the spend cap, cost by kind, and invoices.",
    next: [
      "Watch tracked tickets and credits as the month goes on.",
      "Owners and admins can upgrade or buy credit packs.",
    ],
    guides: ["billing", "autonomy"],
  },
  "/audit": {
    title: "Audit log",
    purpose:
      "An append-only record of sign-ins, approvals, policy and autonomy changes, and every write to your help desk.",
    next: ["Filter by action or person to answer who did what, and when."],
    guides: ["team-security"],
  },
  "/team": {
    title: "Team",
    purpose: "Everyone in your organization, their role and two-factor status, and pending invitations.",
    next: ["Invite your support leads and agents.", "Reset a member's two-factor if they lost their device."],
    guides: ["team-security", "getting-started"],
  },
  "/settings": {
    title: "Settings",
    purpose:
      "Your organization, your own security (two-factor, passkeys), single sign-on, alert channels and appearance.",
    next: ["Add an alert channel under Notifications.", "Add a passkey under Security."],
    guides: ["alerts", "team-security"],
  },
  "/help": {
    title: "Help center",
    purpose: "Short guides to every part of slai, a FAQ and a glossary. Press ? anywhere to come back here.",
    next: ["Search for a question, or start with Getting started."],
    guides: ["getting-started", "faq"],
  },
  "/help/$guideId": {
    title: "Guide",
    purpose: "A guide from the help center.",
    next: ["Follow the related guides at the end."],
    guides: ["getting-started", "glossary"],
  },
};
