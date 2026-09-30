import type { GuideId } from "./types";

/** Guide titles without their bodies (for links from inside other guides without import cycles). */
export const GUIDE_TITLES: Record<GuideId, string> = {
  "getting-started": "Getting started",
  "sla-clock": "How the SLA clock works",
  "contract-review": "Reviewing a contract",
  autonomy: "Choosing autonomy",
  knowledge: "Knowledge",
  approvals: "Approvals",
  alerts: "Alerts and notifications",
  replay: "Breach Replay and money",
  connections: "Connections",
  "team-security": "Team and security",
  billing: "Billing",
  faq: "FAQ",
  glossary: "Glossary",
};
