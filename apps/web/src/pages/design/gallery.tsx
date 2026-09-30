import {
  Avatar,
  Badge,
  Button,
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  Checkbox,
  CitationQuote,
  Dialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  Field,
  formatDuration,
  formatMoney,
  IconButton,
  Input,
  Kbd,
  LogoMark,
  OrgSwitcher,
  Progress,
  RISKS,
  RiskBadge,
  RiskDot,
  SegmentedControl,
  Select,
  Sheet,
  Sidebar,
  SidebarItemContent,
  SidebarSection,
  Skeleton,
  SkeletonRows,
  SlaBar,
  SlaClock,
  type SortDirection,
  Sparkline,
  Stat,
  Switch,
  sidebarItemClass,
  Table,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  TBody,
  TD,
  Textarea,
  TH,
  THead,
  TicketTimeline,
  Tooltip,
  TR,
  toast,
} from "@slai/ui";
import {
  Archive,
  Bot,
  Copy,
  Gauge,
  Inbox,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Send,
  Ticket,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Code, Example, Section } from "./doc";

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Fixed demo instants relative to page load so the clocks tick. */
function useDemoTimes() {
  return useMemo(() => {
    const now = Date.now();
    return {
      now,
      ok: new Date(now + 5 * HOUR + 42 * MIN).toISOString(),
      warning: new Date(now + 48 * MIN + 13_000).toISOString(),
      atRisk: new Date(now + 6 * MIN + 41_000).toISOString(),
      overdue: new Date(now - 12 * MIN - 5_000).toISOString(),
      days: new Date(now + 3 * 24 * HOUR + 4 * HOUR).toISOString(),
    };
  }, []);
}

const ROWS = [
  {
    key: "#48213",
    subject: "Production API returning 502s",
    customer: "Northwind Health",
    risk: "breached",
    left: -12,
  },
  { key: "#48220", subject: "SSO login loop after cert rotation", customer: "Kestrel Bank", risk: "at_risk", left: 7 },
  { key: "#48227", subject: "Webhook deliveries delayed", customer: "Halcyon Retail", risk: "warning", left: 48 },
  { key: "#48234", subject: "Billing export missing invoices", customer: "Parcelhub", risk: "ok", left: 342 },
] as const;

function TableDemo() {
  const [dir, setDir] = useState<SortDirection>("asc");
  const rows = [...ROWS].sort((a, b) => (dir === "desc" ? b.left - a.left : a.left - b.left));
  const t = useDemoTimes();
  return (
    <Table aria-label="Example tickets" maxHeight={260} containerClassName="rounded-md border border-line">
      <THead>
        <tr>
          <TH>Ticket</TH>
          <TH>Customer</TH>
          <TH>Risk</TH>
          <TH sortable sortDirection={dir} onSort={() => setDir(dir === "asc" ? "desc" : "asc")} align="right">
            Due
          </TH>
        </tr>
      </THead>
      <TBody>
        {rows.map((r) => (
          <TR key={r.key} interactive>
            <TD>
              <span className="font-mono text-xs text-ink-muted">{r.key}</span>{" "}
              <span className="font-medium">{r.subject}</span>
            </TD>
            <TD className="text-ink-muted">{r.customer}</TD>
            <TD>
              <RiskBadge risk={r.risk} size="sm" />
            </TD>
            <TD align="right">
              <SlaClock dueAt={new Date(t.now + r.left * MIN).toISOString()} risk={r.risk} size="sm" />
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

function FormsDemo() {
  const [priority, setPriority] = useState("high");
  const [range, setRange] = useState("90");
  const [checked, setChecked] = useState(true);
  const [on, setOn] = useState(true);
  return (
    <div className="grid w-full gap-5 md:grid-cols-2">
      <Field label="Connection name" hint="Shown in lists and alerts.">
        <Input placeholder="Acme Zendesk" defaultValue="Acme Zendesk" />
      </Field>
      <Field label="API token" error="Zendesk rejected this token (401).">
        <Input type="password" defaultValue="not-a-real-token" />
      </Field>
      <Field label="Priority">
        <Select
          value={priority}
          onValueChange={setPriority}
          options={[
            { value: "urgent", label: "Urgent" },
            { value: "high", label: "High" },
            { value: "normal", label: "Normal" },
            { value: "low", label: "Low" },
          ]}
        />
      </Field>
      <Field label="Search" hint="Leading and trailing slots.">
        <Input placeholder="Search tickets" leading={<Search />} trailing={<Kbd>/</Kbd>} />
      </Field>
      <Field label="Reason for rejecting" className="md:col-span-2">
        <Textarea placeholder="Optional. Helps the agent learn your tone." rows={3} />
      </Field>
      <Field inline label="Pause resolution while pending" hint="Waiting on the customer stops the clock.">
        <Checkbox checked={checked} onCheckedChange={(v) => setChecked(v === true)} />
      </Field>
      <Field inline label="Require two-factor for everyone">
        <Switch checked={on} onCheckedChange={setOn} />
      </Field>
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-ink">Segmented control</span>
        <SegmentedControl
          aria-label="Replay window"
          value={range}
          onValueChange={setRange}
          options={[
            { value: "30", label: "30 days" },
            { value: "60", label: "60 days" },
            { value: "90", label: "90 days" },
          ]}
        />
      </div>
    </div>
  );
}

function OverlaysDemo() {
  const [dialog, setDialog] = useState(false);
  const [sheet, setSheet] = useState(false);
  return (
    <>
      <Dialog
        open={dialog}
        onOpenChange={setDialog}
        trigger={<Button>Open dialog</Button>}
        title="Reject this draft?"
        description="The ticket keeps its clock. The agent won't retry until the next risk change."
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => setDialog(false)}>
              Reject draft
            </Button>
          </>
        }
      >
        <Field label="Reason (optional)">
          <Textarea rows={3} />
        </Field>
      </Dialog>
      <Sheet
        open={sheet}
        onOpenChange={setSheet}
        trigger={<Button>Open sheet</Button>}
        title="Enterprise Premier · v3"
        description="Active since Aug 22 · approved by Maya Okafor"
        footer={<Button onClick={() => setSheet(false)}>Close</Button>}
      >
        <p className="text-sm text-ink-muted">Side panels hold detail without losing the list behind them.</p>
      </Sheet>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton label="More actions" icon={<MoreHorizontal />} variant="secondary" />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuLabel>Policy</DropdownMenuLabel>
          <DropdownMenuItem shortcut="E">
            <Pencil aria-hidden /> Edit draft
          </DropdownMenuItem>
          <DropdownMenuItem>
            <Copy aria-hidden /> Duplicate
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem destructive>
            <Archive aria-hidden /> Archive
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Tooltip content="Business hours: Mon–Fri 08:00–20:00 America/New_York">
        <Button variant="ghost">Hover or focus me</Button>
      </Tooltip>
      <Button
        onClick={() =>
          toast({
            tone: "success",
            title: "Reply sent",
            description: "#48220 · first response met with 6m 41s to spare.",
          })
        }
      >
        Success toast
      </Button>
      <Button
        onClick={() =>
          toast({
            tone: "error",
            title: "Couldn't send reply",
            description: "Zendesk returned 429. We'll retry in 30s.",
            action: { label: "Retry now", altText: "Retry sending the reply now", onClick: () => {} },
          })
        }
      >
        Error toast
      </Button>
    </>
  );
}

export function Gallery() {
  const t = useDemoTimes();
  const HOUR_MS = HOUR;
  return (
    <>
      <Section
        id="buttons"
        title="Buttons"
        lead="One primary action per view. Icon-only buttons require a label (it becomes the tooltip and accessible name)."
      >
        <Example
          title="Variants and sizes"
          code={`<Button variant="primary" leadingIcon={<Send />}>Approve & send</Button>
<IconButton label="Refresh" icon={<RefreshCw />} />`}
        >
          <Button variant="primary" leadingIcon={<Send />}>
            Approve &amp; send
          </Button>
          <Button>Save draft</Button>
          <Button variant="ghost">Cancel</Button>
          <Button variant="danger" leadingIcon={<Trash2 />}>
            Remove
          </Button>
          <Button variant="link">View contract</Button>
          <Button variant="primary" loading>
            Approving
          </Button>
          <Button disabled>Disabled</Button>
          <span className="mx-2 h-6 w-px bg-line" />
          <Button size="sm" variant="primary">
            Small
          </Button>
          <Button size="lg" variant="primary" leadingIcon={<Plus />}>
            Large
          </Button>
          <IconButton label="Refresh" icon={<RefreshCw />} />
          <IconButton label="Run agent" icon={<Bot />} variant="secondary" />
        </Example>
      </Section>

      <Section
        id="forms"
        title="Form controls"
        lead="Wrap every control in a Field: it wires the label, hint, error (announced with role=alert) and aria-invalid automatically."
      >
        <Example
          title="Field, Input, Select, Textarea, Checkbox, Switch"
          code={`<Field label="API token" error="Zendesk rejected this token (401).">
  <Input type="password" />
</Field>`}
        >
          <FormsDemo />
        </Example>
      </Section>

      <Section
        id="status"
        title="Badges and risk"
        lead="RiskBadge is the only way to show risk: icon, label and color together. RiskDot is for dense legends next to a text label."
      >
        <Example title="RiskBadge" code={`<RiskBadge risk="at_risk" />`}>
          {RISKS.map((r) => (
            <RiskBadge key={r} risk={r} />
          ))}
          {RISKS.map((r) => (
            <RiskBadge key={`s${r}`} risk={r} size="sm" />
          ))}
          <RiskBadge risk="breached" label="Breached ×2" />
        </Example>
        <Example title="Badge tones">
          <Badge>Draft</Badge>
          <Badge tone="accent">Growth plan</Badge>
          <Badge tone="ok">Active</Badge>
          <Badge tone="warning">Needs review</Badge>
          <Badge tone="breached">Error</Badge>
          <Badge tone="outline">v3</Badge>
          <span className="inline-flex items-center gap-1.5 text-sm">
            <RiskDot risk="at_risk" pulse /> 6 at risk
          </span>
        </Example>
      </Section>

      <Section
        id="signature"
        title="Signature components"
        lead="The product's own vocabulary. Clocks share one 1-second ticker, freeze while paused, and flip to an overdue count-up. Bars show the fraction of the target consumed with the warn thresholds marked."
      >
        <Example
          title="SlaClock"
          description="Live countdown to dueAt in tabular mono. role=timer with a minute-resolution accessible name, so screen readers aren't flooded every second."
          code={`<SlaClock dueAt={ticket.next.dueAt} state={ticket.next.state} remainingMs={ticket.next.remainingMs} risk={ticket.risk} />`}
          className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3"
        >
          <div className="flex flex-col gap-1">
            <span className="text-xs text-ink-muted">On track</span>
            <SlaClock dueAt={t.ok} risk="ok" size="lg" />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-ink-muted">Warning</span>
            <SlaClock dueAt={t.warning} risk="warning" size="lg" />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-ink-muted">At risk</span>
            <SlaClock dueAt={t.atRisk} risk="at_risk" size="lg" />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-ink-muted">Overdue</span>
            <SlaClock dueAt={t.overdue} risk="breached" size="lg" />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-ink-muted">Paused (waiting on customer)</span>
            <SlaClock dueAt={null} state="paused" remainingMs={2 * HOUR_MS + 14 * MIN} size="lg" />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-ink-muted">Sizes: md · sm · days · met · n/a</span>
            <div className="flex flex-wrap items-center gap-3">
              <SlaClock dueAt={t.warning} risk="warning" />
              <SlaClock dueAt={t.atRisk} risk="at_risk" size="sm" />
              <SlaClock dueAt={t.days} size="sm" />
              <SlaClock dueAt={null} state="achieved" size="sm" />
              <SlaClock dueAt={null} state="not_applicable" size="sm" />
            </div>
          </div>
        </Example>
        <Example
          title="SlaBar"
          description="role=meter with a spoken value (“62% of target used, warning”). Ticks mark warnAt; past 100% the bar caps and hatches."
          code={`<SlaBar label="First response" elapsedMs={m.elapsedMs} targetMs={m.targetMs} warnAt={policy.warnAt} risk={m.risk} showScale />`}
          className="grid gap-5 sm:grid-cols-2"
        >
          {[
            ["30% · ok", 0.3],
            ["62% · warning", 0.62],
            ["91% · at risk", 0.91],
            ["140% · breached", 1.4],
          ].map(([label, f]) => (
            <div key={label as string} className="flex flex-col gap-1.5">
              <span className="text-xs text-ink-muted">{label}</span>
              <SlaBar label={label as string} elapsedMs={(f as number) * HOUR_MS} targetMs={HOUR_MS} showScale />
            </div>
          ))}
          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-ink-muted">Paused at 45%</span>
            <SlaBar label="Paused" elapsedMs={0.45 * HOUR_MS} targetMs={HOUR_MS} paused showScale />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-ink-muted">Custom thresholds [0.7, 0.9], small</span>
            <SlaBar
              label="Custom"
              elapsedMs={0.75 * HOUR_MS}
              targetMs={HOUR_MS}
              warnAt={[0.7, 0.9]}
              size="sm"
              showScale
            />
          </div>
        </Example>
        <Example
          title="TicketTimeline"
          description="Public replies (globe, solid) and internal notes (lock, dashed, sunken) differ by icon, label and treatment, because only public replies stop response clocks."
          className="block"
        >
          <TicketTimeline
            items={[
              {
                at: new Date(t.now - 3 * HOUR_MS).toISOString(),
                type: "created",
                label: "Ticket created with priority urgent",
              },
              {
                at: new Date(t.now - 3 * HOUR_MS + 30_000).toISOString(),
                type: "comment",
                label: "Since 09:40 UTC every call to /v2/orders from our EU tenants fails with a 502.",
                author: "Jordan Hart",
                public: true,
              },
              {
                at: new Date(t.now - 2.6 * HOUR_MS).toISOString(),
                type: "comment",
                label: "Repro confirmed on staging. Pinged #platform-oncall.",
                author: "Priya Raman",
                public: false,
              },
              {
                at: new Date(t.now - 2.5 * HOUR_MS).toISOString(),
                type: "sla_warning",
                label: "Resolution passed 50% of target",
              },
              {
                at: new Date(t.now - 2.2 * HOUR_MS).toISOString(),
                type: "comment",
                label: "Hi Jordan, we've identified the cause and are rolling back now.",
                author: "Priya Raman",
                public: true,
              },
              {
                at: new Date(t.now - HOUR_MS).toISOString(),
                type: "sla_breached",
                label: "Resolution target breached",
              },
            ]}
          />
        </Example>
        <Example
          title="CitationQuote"
          description="Every number in an extracted policy links to the clause it came from. Ambiguous clauses are marked for review."
          className="grid gap-3 md:grid-cols-2"
        >
          <CitationQuote
            quote="Severity 1: the Supplier shall acknowledge the Incident within thirty (30) minutes of notification."
            document="Kestrel Bank — MSA.pdf"
            page={12}
            fieldLabel="First response · Urgent"
            onSelect={() => {}}
          />
          <CitationQuote
            quote="Time during which the Supplier is awaiting information from the Customer shall not count towards the Resolution Time."
            document="Kestrel Bank — MSA.pdf"
            page={13}
            fieldLabel="Pause · Resolution"
            ambiguous
            active
          />
        </Example>
      </Section>

      <Section
        id="data"
        title="Data display"
        lead="Stats lead with one tabular number. Sparklines are 1.5px, single-series, and always sit beside a number or a label."
      >
        <Example title="Stat + Sparkline" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="Attainment"
            value="97.6%"
            detail="+0.8 pts vs last month"
            detailTone="good"
            trend={
              <Sparkline values={[96.1, 96.8, 95.2, 97.1, 97.4, 96.9, 97.8, 97.6]} label="Attainment trending up" />
            }
          />
          <Stat
            label="At risk now"
            value="16"
            detail="7 breached, 9 at risk"
            detailTone="bad"
            icon={<TriangleAlert />}
          />
          <Stat label="Exposure this period" value={formatMoney(1_842_500)} detail="From credit clauses" />
          <Stat
            label="Breaches saved"
            value="23"
            detail={`${formatMoney(2_310_000)} in credits avoided`}
            detailTone="good"
          />
        </Example>
        <Example
          title="Table (sticky header, sortable)"
          className="block"
          code={`<TH sortable sortDirection={dir} onSort={toggle}>Due</TH>`}
        >
          <TableDemo />
        </Example>
        <Example title="Tabs" className="block">
          <Tabs defaultValue="clocks">
            <TabsList>
              <TabsTrigger value="clocks">
                <Gauge aria-hidden /> Clocks
              </TabsTrigger>
              <TabsTrigger value="timeline">
                <Ticket aria-hidden /> Timeline
              </TabsTrigger>
              <TabsTrigger value="drafts">
                <Inbox aria-hidden /> Drafts
              </TabsTrigger>
            </TabsList>
            <TabsContent value="clocks" className="text-sm text-ink-muted">
              Arrow keys move between tabs; the panel is focusable.
            </TabsContent>
            <TabsContent value="timeline" className="text-sm text-ink-muted">
              Timeline panel.
            </TabsContent>
            <TabsContent value="drafts" className="text-sm text-ink-muted">
              Drafts panel.
            </TabsContent>
          </Tabs>
        </Example>
        <Example title="Avatar, Kbd, Progress">
          <Avatar name="Maya Okafor" size="lg" />
          <Avatar name="Tomás Ibarra" size="md" />
          <Avatar name="Priya Raman" />
          <Avatar name="Kofi Mensah" size="xs" />
          <span className="inline-flex items-center gap-1 text-sm text-ink-muted">
            <Kbd>j</Kbd> <Kbd>k</Kbd> move · <Kbd>a</Kbd> approve · <Kbd>r</Kbd> reject
          </span>
          <div className="w-56">
            <Progress value={62} label="Uploading contract" />
          </div>
          <div className="w-56">
            <Progress label="Extracting" />
          </div>
        </Example>
      </Section>

      <Section
        id="overlays"
        title="Overlays and feedback"
        lead="Radix primitives provide focus trapping, escape to close, and portals. Toasts live in an aria-live region; errors persist longer."
      >
        <Example title="Dialog, Sheet, DropdownMenu, Tooltip, Toast">
          <OverlaysDemo />
        </Example>
      </Section>

      <Section
        id="states"
        title="Loading, empty and error"
        lead="Every page has all three. Skeletons match the shape of what's coming; empty states say what to do next; errors say what failed and offer a retry."
      >
        <div className="grid gap-4 lg:grid-cols-3">
          <Card>
            <CardHeader title="Loading" description="Skeleton rows with a polite status" />
            <CardContent>
              <SkeletonRows rows={4} />
              <div className="mt-4 flex gap-2">
                <Skeleton className="h-8 w-24" />
                <Skeleton className="h-8 w-16" />
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader title="Empty" />
            <EmptyState
              compact
              icon={<Inbox />}
              title="Inbox zero"
              description="No drafts are waiting. New drafts appear here when a ticket reaches its trigger risk."
            />
          </Card>
          <Card>
            <CardHeader title="Error" />
            <EmptyState
              compact
              tone="error"
              icon={<TriangleAlert />}
              title="Couldn't load tickets"
              description="Can't reach slai. Check your connection and try again."
              action={<Button size="sm">Try again</Button>}
            />
          </Card>
        </div>
      </Section>

      <Section
        id="shell"
        title="App shell"
        lead="A docked sidebar at lg and up; below that it opens as a drawer from the top bar. The org switcher sits first in the top bar. Nav links use sidebarItemClass, which styles aria-current=page."
      >
        <div className="overflow-hidden rounded-lg border border-line">
          <div className="flex h-80 bg-canvas">
            <div className="hidden w-56 shrink-0 border-r border-line sm:block">
              <Sidebar
                header={
                  <span className="inline-flex items-center gap-2 text-sm font-semibold">
                    <LogoMark /> slai
                  </span>
                }
              >
                <SidebarSection title="Operate">
                  <li>
                    <a href="#shell" aria-current="page" className={sidebarItemClass}>
                      <SidebarItemContent icon={<Gauge />} label="Dashboard" />
                    </a>
                  </li>
                  <li>
                    <a href="#shell" className={sidebarItemClass}>
                      <SidebarItemContent icon={<Ticket />} label="Tickets" />
                    </a>
                  </li>
                  <li>
                    <a href="#shell" className={sidebarItemClass}>
                      <SidebarItemContent icon={<Inbox />} label="Approvals" badge={7} />
                    </a>
                  </li>
                </SidebarSection>
              </Sidebar>
            </div>
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex h-14 items-center gap-2 border-b border-line px-4">
                <OrgSwitcher
                  current={{ id: "a", name: "Acme Cloud", plan: "growth" }}
                  organizations={[
                    { id: "a", name: "Acme Cloud", role: "owner" },
                    { id: "b", name: "Acme Cloud (Sandbox)", role: "admin" },
                  ]}
                  onSwitch={(id) => toast({ title: `Switch to ${id}` })}
                />
                <div className="ml-auto">
                  <Avatar name="Maya Okafor" size="md" />
                </div>
              </div>
              <div className="p-5">
                <Card>
                  <CardHeader
                    title="Card title"
                    description="Cards group one idea."
                    actions={<Button size="sm">Action</Button>}
                  />
                  <CardContent className="text-sm text-ink-muted">
                    Content sits on the 4px grid with 20px card padding.
                  </CardContent>
                  <CardFooter>
                    <Button size="sm" variant="ghost">
                      Cancel
                    </Button>
                    <Button size="sm" variant="primary">
                      Save
                    </Button>
                  </CardFooter>
                </Card>
              </div>
            </div>
          </div>
        </div>
      </Section>

      <Section
        id="format"
        title="Formatting"
        lead="Durations are exact and truncate (never round up time left). Money is integer cents on the wire, USD in the UI."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-line bg-surface p-4 font-mono text-sm tnum">
            {[72 * MIN, (3 * 24 + 4) * HOUR_MS, 42_000, 2 * HOUR_MS].map((ms) => (
              <div key={ms} className="flex justify-between border-b border-line py-1.5 last:border-0">
                <span className="text-ink-muted">formatDuration({ms})</span>
                <span>{formatDuration(ms)}</span>
              </div>
            ))}
          </div>
          <div className="rounded-lg border border-line bg-surface p-4 font-mono text-sm tnum">
            {(
              [
                [1_842_500, "whole"],
                [1999, "exact"],
                [4_862_500, "compact"],
              ] as const
            ).map(([c, m]) => (
              <div key={m} className="flex justify-between border-b border-line py-1.5 last:border-0">
                <span className="text-ink-muted">
                  formatMoney({c}, "{m}")
                </span>
                <span>{formatMoney(c, m)}</span>
              </div>
            ))}
          </div>
        </div>
      </Section>

      <Section id="usage" title="Using the system">
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-lg border border-line bg-surface p-5 text-sm text-ink-muted">
            <p className="font-semibold text-ink">Install in an app</p>
            <ol className="mt-2 list-decimal space-y-1.5 pl-5">
              <li>
                Depend on <Code>@slai/ui</Code> and import <Code>@slai/ui/styles.css</Code> once from your entry CSS;
                add <Code>@source</Code> for your own files.
              </li>
              <li>Load Instrument Sans, JetBrains Mono and Newsreader from Google Fonts in the page head.</li>
              <li>
                Wrap the app in <Code>ThemeProvider</Code>, <Code>TooltipProvider</Code>, and mount one{" "}
                <Code>Toaster</Code>.
              </li>
              <li>
                Theme: <Code>data-theme="light|dark"</Code> on <Code>&lt;html&gt;</Code>, or none to follow the OS.
              </li>
            </ol>
          </div>
          <div className="rounded-lg border border-line bg-surface p-5 text-sm text-ink-muted">
            <p className="font-semibold text-ink">Rules</p>
            <ul className="mt-2 list-disc space-y-1.5 pl-5">
              <li>Use role utilities (bg-surface, text-ink-muted, border-line), never raw hex.</li>
              <li>Risk: RiskBadge / RISK_META only. Never color alone; never reuse risk colors for categories.</li>
              <li>Numbers that change or align: font-mono + tnum.</li>
              <li>Icon-only controls: IconButton with a label.</li>
              <li>Clocks and risk come from the engine via the API; the UI formats, it doesn't decide.</li>
            </ul>
          </div>
        </div>
      </Section>
    </>
  );
}
