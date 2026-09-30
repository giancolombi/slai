import type { SlaPolicy } from "@slai/sla-engine";

/** Engine-shaped policy definitions used by the mock API. */

const weekdays = (start: string, end: string) => ({
  mon: [{ start, end }],
  tue: [{ start, end }],
  wed: [{ start, end }],
  thu: [{ start, end }],
  fri: [{ start, end }],
});

const US_HOLIDAYS_2026 = [
  "2026-01-01",
  "2026-01-19",
  "2026-02-16",
  "2026-05-25",
  "2026-06-19",
  "2026-07-03",
  "2026-09-07",
  "2026-10-12",
  "2026-11-11",
  "2026-11-26",
  "2026-12-25",
];

export const premierDefinition: SlaPolicy = {
  id: "pol_premier",
  name: "Enterprise Premier",
  calendar: { timezone: "America/New_York", weekly: weekdays("08:00", "20:00"), holidays: US_HOLIDAYS_2026 },
  targets: [
    { metric: "first_response", priority: "urgent", minutes: 60, clock: "calendar" },
    { metric: "first_response", priority: "high", minutes: 120, clock: "business" },
    { metric: "first_response", priority: "normal", minutes: 480, clock: "business" },
    { metric: "first_response", priority: "low", minutes: 1440, clock: "business" },
    { metric: "next_response", priority: "urgent", minutes: 120, clock: "calendar" },
    { metric: "next_response", priority: "high", minutes: 240, clock: "business" },
    { metric: "next_response", priority: "normal", minutes: 720, clock: "business" },
    { metric: "resolution", priority: "urgent", minutes: 480, clock: "calendar" },
    { metric: "resolution", priority: "high", minutes: 1440, clock: "business" },
    { metric: "resolution", priority: "normal", minutes: 4320, clock: "business" },
    { metric: "resolution", priority: "low", minutes: 7200, clock: "business" },
  ],
  defaultPriority: "normal",
  pauseStatuses: { resolution: ["pending", "on_hold"], next_response: ["pending"] },
  botRepliesCount: false,
  warnAt: [0.5, 0.8],
  credits: [
    {
      id: "cr_premier_breach",
      basis: "per_breach",
      metric: "first_response",
      priority: "urgent",
      amount: { kind: "percent_of_fee", percent: 2 },
      capPercent: 20,
      sourceClause: "§7.2",
    },
    {
      id: "cr_premier_attain",
      basis: "attainment",
      metric: null,
      priority: null,
      tiers: [
        { belowPercent: 95, amount: { kind: "percent_of_fee", percent: 5 } },
        { belowPercent: 90, amount: { kind: "percent_of_fee", percent: 10 } },
      ],
      capPercent: 25,
      sourceClause: "§7.3",
    },
  ],
};

export const standardDefinition: SlaPolicy = {
  id: "pol_standard",
  name: "Standard Business",
  calendar: { timezone: "America/Chicago", weekly: weekdays("09:00", "17:00"), holidays: US_HOLIDAYS_2026 },
  targets: [
    { metric: "first_response", priority: "urgent", minutes: 120, clock: "business" },
    { metric: "first_response", priority: "high", minutes: 240, clock: "business" },
    { metric: "first_response", priority: "normal", minutes: 960, clock: "business" },
    { metric: "first_response", priority: "low", minutes: 1920, clock: "business" },
    { metric: "resolution", priority: "urgent", minutes: 960, clock: "business" },
    { metric: "resolution", priority: "high", minutes: 2400, clock: "business" },
    { metric: "resolution", priority: "normal", minutes: 7200, clock: "business" },
  ],
  defaultPriority: "normal",
  pauseStatuses: { resolution: ["pending"] },
  botRepliesCount: false,
  warnAt: [0.5, 0.8],
  credits: [
    {
      id: "cr_std_attain",
      basis: "attainment",
      metric: "first_response",
      priority: null,
      tiers: [{ belowPercent: 95, amount: { kind: "percent_of_fee", percent: 5 } }],
      capPercent: 10,
      sourceClause: "Schedule B §3",
    },
  ],
};

/** The draft extracted from the Kestrel Bank MSA, waiting for review. */
export const kestrelDraftDefinition: SlaPolicy = {
  id: "pol_kestrel",
  name: "Kestrel Bank MSA",
  calendar: {
    timezone: "Europe/London",
    weekly: weekdays("08:00", "18:00"),
    holidays: ["2026-12-25", "2026-12-28", "2027-01-01"],
  },
  targets: [
    { metric: "first_response", priority: "urgent", minutes: 30, clock: "calendar" },
    { metric: "first_response", priority: "high", minutes: 60, clock: "business" },
    { metric: "first_response", priority: "normal", minutes: 240, clock: "business" },
    { metric: "first_response", priority: "low", minutes: 600, clock: "business" },
    { metric: "periodic_update", priority: "urgent", minutes: 60, clock: "calendar" },
    { metric: "periodic_update", priority: "high", minutes: 240, clock: "business" },
    { metric: "resolution", priority: "urgent", minutes: 240, clock: "calendar" },
    { metric: "resolution", priority: "high", minutes: 600, clock: "business" },
    { metric: "resolution", priority: "normal", minutes: 2400, clock: "business" },
  ],
  defaultPriority: "normal",
  pauseStatuses: { resolution: ["pending"] },
  botRepliesCount: false,
  warnAt: [0.5, 0.8],
  credits: [
    {
      id: "cr_kestrel_breach",
      basis: "per_breach",
      metric: "resolution",
      priority: "urgent",
      amount: { kind: "fixed_cents", cents: 250_000 },
      capPercent: 15,
      sourceClause: "§9.4(a)",
    },
    {
      id: "cr_kestrel_attain",
      basis: "attainment",
      metric: "first_response",
      priority: null,
      tiers: [
        { belowPercent: 98, amount: { kind: "percent_of_fee", percent: 5 } },
        { belowPercent: 95, amount: { kind: "percent_of_fee", percent: 10 } },
        { belowPercent: 90, amount: { kind: "percent_of_fee", percent: 15 } },
      ],
      capPercent: 15,
      sourceClause: "§9.4(b)",
    },
  ],
};

export const KESTREL_DOC = "Kestrel Bank — Master Services Agreement.pdf";

export const kestrelCitations: { path: string; quote: string; document: string; page: number | null }[] = [
  {
    path: "calendar.timezone",
    quote:
      "“Business Hours” means 08:00 to 18:00 UK time on any Business Day, being a day other than a Saturday, Sunday or public holiday in England.",
    document: KESTREL_DOC,
    page: 3,
  },
  {
    path: "calendar.weekly",
    quote:
      "Support Services shall be available during Business Hours, save for Severity 1 Incidents which shall be supported 24 hours a day, 7 days a week.",
    document: KESTREL_DOC,
    page: 11,
  },
  {
    path: "calendar.holidays",
    quote: "The Supplier's offices will be closed on 25 and 28 December 2026 and 1 January 2027.",
    document: KESTREL_DOC,
    page: 11,
  },
  {
    path: "targets.first_response.urgent",
    quote: "Severity 1: the Supplier shall acknowledge the Incident within thirty (30) minutes of notification.",
    document: KESTREL_DOC,
    page: 12,
  },
  {
    path: "targets.first_response.high",
    quote: "Severity 2: acknowledgement within one (1) Business Hour.",
    document: KESTREL_DOC,
    page: 12,
  },
  {
    path: "targets.first_response.normal",
    quote: "Severity 3: acknowledgement within four (4) Business Hours.",
    document: KESTREL_DOC,
    page: 12,
  },
  {
    path: "targets.first_response.low",
    quote: "Severity 4 (requests and questions): acknowledgement within one (1) Business Day.",
    document: KESTREL_DOC,
    page: 12,
  },
  {
    path: "targets.periodic_update.urgent",
    quote:
      "For Severity 1 Incidents the Supplier shall provide status updates at least every sixty (60) minutes until resolution.",
    document: KESTREL_DOC,
    page: 12,
  },
  {
    path: "targets.periodic_update.high",
    quote: "Severity 2 Incidents: status updates every four (4) Business Hours.",
    document: KESTREL_DOC,
    page: 12,
  },
  {
    path: "targets.resolution.urgent",
    quote: "Severity 1: Resolution or an acceptable Workaround within four (4) hours.",
    document: KESTREL_DOC,
    page: 13,
  },
  {
    path: "targets.resolution.high",
    quote: "Severity 2: Resolution or Workaround within one (1) Business Day.",
    document: KESTREL_DOC,
    page: 13,
  },
  {
    path: "targets.resolution.normal",
    quote: "Severity 3: Resolution within five (5) Business Days.",
    document: KESTREL_DOC,
    page: 13,
  },
  {
    path: "pauseStatuses.resolution",
    quote:
      "Time during which the Supplier is awaiting information or action from the Customer shall not count towards the Resolution Time.",
    document: KESTREL_DOC,
    page: 13,
  },
  {
    path: "credits.cr_kestrel_breach",
    quote:
      "For each Severity 1 Incident not Resolved within the Resolution Time, a Service Credit of £2,500 shall apply, not to exceed fifteen per cent (15%) of the Monthly Charges.",
    document: KESTREL_DOC,
    page: 19,
  },
  {
    path: "credits.cr_kestrel_attain",
    quote:
      "Where Acknowledgement attainment in a month falls below 98%, 95% or 90%, Service Credits of 5%, 10% or 15% of the Monthly Charges respectively shall apply.",
    document: KESTREL_DOC,
    page: 19,
  },
];

export const kestrelAmbiguities: { path: string; question: string; assumption: string; quote: string | null }[] = [
  {
    path: "targets.first_response.low",
    question: "“One Business Day” for Severity 4: a full 10 business hours, or by 08:00 the next Business Day?",
    assumption: "One Business Day = 10 business hours (600 minutes), the length of a Business Day in §1.1.",
    quote: "Severity 4 (requests and questions): acknowledgement within one (1) Business Day.",
  },
  {
    path: "credits.cr_kestrel_breach",
    question: "The credit is stated in GBP (£2,500). slai measures money in USD cents. Which conversion should apply?",
    assumption: "Convert at a fixed rate of 1 GBP = 1.00 USD until finance confirms (recorded as $2,500).",
    quote: "a Service Credit of £2,500 shall apply",
  },
  {
    path: "pauseStatuses.resolution",
    question: "Does “awaiting action from the Customer” also cover tickets on hold for a third party (on_hold)?",
    assumption: "Only “pending” (waiting on the customer) pauses resolution; “on hold” keeps the clock running.",
    quote:
      "Time during which the Supplier is awaiting information or action from the Customer shall not count towards the Resolution Time.",
  },
];
