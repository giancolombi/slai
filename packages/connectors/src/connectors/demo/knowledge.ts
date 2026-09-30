/**
 * The demo help center (T-47): a fixed set of help articles for the demo
 * help desk's ticket categories (content.ts), so drafts have facts to rely on.
 * The same for every seed; fictional product, reserved `.example` domain.
 */

export const DEMO_HELP_CENTER = "https://help.acme-cloud.example";

export interface DemoArticle {
  slug: string;
  title: string;
  /** Plain text; the first two sentences are what a mock draft quotes. */
  body: string;
  /** Days after 2026-01-05 the article was last updated. */
  updatedDay: number;
}

export const DEMO_ARTICLES: DemoArticle[] = [
  // ---------- login / SSO ----------
  {
    slug: "saml-assertion-errors",
    title: "Fixing SAML assertion errors during SSO login",
    body: 'An "Invalid SAML assertion: audience mismatch" error means the Audience URI your identity provider sends does not match the Entity ID shown under Settings → Security → Single sign-on. Copy the Entity ID from that page into the Audience URI (SP Entity ID) field of your Okta, Azure AD or Google Workspace app, then ask an affected user to sign in again.\n\nIf the values already match, capture a SAML trace with the SAML-tracer browser extension and check the assertion\'s Conditions → AudienceRestriction element. After a certificate rotation, also confirm the IdP is signing with the current certificate.',
    updatedDay: 212,
  },
  {
    slug: "scim-provisioning-okta",
    title: "SCIM provisioning with Okta: why users get deactivated",
    body: 'When SCIM provisioning is enabled, your identity provider owns user lifecycle, so a user who is not assigned to the app (directly or through a group) is deactivated at the next sync. To restore access, assign the affected users or their group to the Acme Cloud app in Okta and run "Push now" on the Push Groups tab.\n\nDeactivated users keep their data and are reactivated automatically once the IdP sends active=true. Pre-existing users are matched by email, so make sure the Okta username equals the email they sign in with.',
    updatedDay: 190,
  },
  {
    slug: "2fa-codes-not-arriving",
    title: "Troubleshooting 2FA codes that don't arrive",
    body: "SMS codes can be delayed or filtered by some mobile carriers, most often for international numbers. Ask affected users to switch to an authenticator app (Google Authenticator, 1Password, Authy) under Profile → Security → Two-factor authentication, which works offline and is not affected by carrier delivery.\n\nAdmins can reset a user's second factor from Settings → Members → the user → Reset 2FA; the user then enrols again at their next sign-in.",
    updatedDay: 160,
  },
  {
    slug: "azure-ad-sign-in-loop",
    title: "Azure AD sign-in loops back to the login page",
    body: "A sign-in loop with Microsoft (Azure AD / Entra ID) usually means the Reply URL registered in Azure does not exactly match the Assertion Consumer Service URL shown under Settings → Security → Single sign-on. Update the Reply URL in the Azure enterprise application, including the trailing path, and save.\n\nBrowsers that block third-party cookies can also cause a loop when the app is embedded; open Acme Cloud directly in a new tab to rule this out.",
    updatedDay: 175,
  },
  {
    slug: "accept-workspace-invite",
    title: "Accepting a workspace invite",
    body: "Invites are tied to the exact email address they were sent to, so a new hire must accept the invite while signed in with that address. If your workspace enforces SSO, new hires should sign in through your identity provider first and then open the invite link.\n\nAn admin can resend an invite from Settings → Members → Pending invites; resending invalidates the previous link.",
    updatedDay: 120,
  },
  // ---------- API ----------
  {
    slug: "events-api-errors",
    title: "Handling 500 errors from the Events API",
    body: "A 500 from POST /v2/events means the request reached us but failed while it was processed; the response includes a request ID (req_...) that our engineers use to find it. Retry the same request with exponential backoff and the same Idempotency-Key header, so a retried event is never stored twice.\n\nIf the errors continue, send us two or three request IDs and a sample payload with any personal data removed.",
    updatedDay: 230,
  },
  {
    slug: "webhook-delivery-retries",
    title: "Webhook deliveries: retries, delays and ordering",
    body: "Webhook deliveries are retried with backoff when your endpoint does not answer with a 2xx within 10 seconds, so a slow or failing endpoint makes later deliveries look delayed. Acknowledge the webhook immediately and process the payload asynchronously on your side.\n\nThe Webhooks page under Settings → Developers shows every delivery attempt with its status code and latency, and lets you replay failed deliveries.",
    updatedDay: 205,
  },
  {
    slug: "api-rate-limits",
    title: "API rate limits and 429 responses",
    body: "Rate limits apply per API key, and each response carries X-RateLimit-Limit, X-RateLimit-Remaining and Retry-After headers so you can see the limit that applies to your key. A 429 below your plan's limit usually means the key belongs to an older integration tier; create a new key under Settings → Developers → API keys to get your plan's limit.\n\nWhen you receive a 429, wait for the number of seconds in Retry-After before retrying.",
    updatedDay: 222,
  },
  {
    slug: "cursor-pagination",
    title: "Paginating API results with cursors",
    body: "List endpoints return a next_cursor value; pass it unchanged as the cursor parameter to fetch the next page, and keep every other query parameter the same. Changing the sort order or filters between pages, or paging with offset parameters, can return duplicate records or skip some.\n\nCursors are stable for 24 hours; after that, start again from the first page.",
    updatedDay: 140,
  },
  {
    slug: "bulk-import-limits",
    title: "Bulk import limits and timeouts",
    body: "The bulk import endpoint accepts up to 5,000 records or 10 MB per request; larger requests can time out before they finish. Split the import into batches below that size and send them one after another.\n\nEach batch returns a job ID you can poll at GET /v2/imports/{id} to see how many records succeeded or failed.",
    updatedDay: 150,
  },
  // ---------- billing ----------
  {
    slug: "invoice-seat-count",
    title: "How seats are counted on your invoice",
    body: "Invoices count every member who was active at any point in the billing period, including users deactivated partway through it. Deactivated users stop counting from the next billing period.\n\nYou can see the seat count behind each invoice under Settings → Billing → Invoices → View seat report.",
    updatedDay: 100,
  },
  {
    slug: "duplicate-charges",
    title: "Seeing two charges on your card",
    body: "A second charge of the same amount is often a temporary authorization hold from a failed payment attempt, which your bank releases on its own. The Billing page lists only the charges that were actually captured.\n\nIf both charges appear under Settings → Billing → Payments, contact support with the charge dates so the billing team can review them.",
    updatedDay: 95,
  },
  {
    slug: "billing-contact-po-number",
    title: "Updating your billing contact, PO number and tax documents",
    body: "Workspace owners can change the billing email and add a PO number under Settings → Billing → Invoice details; both appear on every invoice issued afterwards. Our W-9 and other tax documents can be downloaded from the same page.",
    updatedDay: 88,
  },
  {
    slug: "annual-plan-proration",
    title: "Annual plans and proration",
    body: "Seats added during an annual term are prorated to the end of the term and billed on the next invoice. Seats removed during the term remain billed until the renewal date.",
    updatedDay: 70,
  },
  // ---------- exports ----------
  {
    slug: "large-csv-exports",
    title: "Exporting large workspaces to CSV",
    body: "Exports of more than about five million rows can time out in the browser. Use the asynchronous export option under Settings → Data → Export: it runs in the background and emails you a download link when the CSV file is ready.\n\nYou can also narrow the date range to export in smaller parts.",
    updatedDay: 215,
  },
  {
    slug: "scheduled-export-custom-fields",
    title: "Adding custom fields to scheduled exports",
    body: "Scheduled exports keep the column list that was saved when the schedule was created, so custom fields added later are not included automatically. Edit the schedule under Settings → Data → Scheduled exports, select the new custom fields in the Columns step, and save.",
    updatedDay: 180,
  },
  {
    slug: "s3-export-access-denied",
    title: "Fixing AccessDenied errors for S3 data exports",
    body: "The S3 export role needs s3:PutObject and s3:PutObjectAcl on the bucket path, because exported files are written with the bucket-owner-full-control ACL. Add both actions to the bucket policy for the role ARN shown under Settings → Data → S3 export, then run the export again.\n\nBuckets encrypted with a customer-managed KMS key also need kms:GenerateDataKey for the same role.",
    updatedDay: 200,
  },
  {
    slug: "personal-data-export",
    title: "Requesting a personal data export",
    body: "Workspace owners can export the personal data held about a member from Settings → Members → the member → Export data. Requests about former employees are handled by our privacy team.",
    updatedDay: 60,
  },
  // ---------- outages ----------
  {
    slug: "service-status",
    title: "Checking service status and incidents",
    body: "Current incidents, their impact by region, and post-incident reports are published on our status page, and you can subscribe to updates by email or Slack there. When reporting a possible outage, include your workspace region and whether all users are affected.",
    updatedDay: 30,
  },
  // ---------- integrations ----------
  {
    slug: "salesforce-sync-troubleshooting",
    title: "Salesforce sync stopped updating records",
    body: 'The Salesforce sync stops when its refresh token expires, which happens after a password reset or when the connected user is deactivated; the integration page can still say "connected". Re-authorize the integration under Settings → Integrations → Salesforce with an active admin user, and missed changes are synced again automatically.\n\nThe sync log on the same page shows the last successful run and any invalid_grant errors.',
    updatedDay: 225,
  },
  {
    slug: "slack-notifications",
    title: "Slack notifications stopped posting",
    body: "Renaming or archiving a Slack channel invalidates the webhook that posts to it, so notifications stop without an error on our side. Reconnect the channel under Settings → Integrations → Slack and pick the renamed channel.\n\nPrivate channels also need the Acme Cloud app invited to them.",
    updatedDay: 170,
  },
  {
    slug: "hubspot-duplicate-contacts",
    title: "HubSpot integration creating duplicate contacts",
    body: 'The HubSpot integration matches existing contacts by email address, so contacts whose email differs in case or has extra spaces are created again. Turn on "Normalize emails before matching" under Settings → Integrations → HubSpot, then use HubSpot\'s duplicate management tool to merge the existing duplicates.',
    updatedDay: 165,
  },
  {
    slug: "zapier-triggers",
    title: "Zapier trigger not firing on new records",
    body: "Zapier polls for new records every few minutes on paid Zapier plans and less often on free plans, and it only sees records created after the Zap was turned on. Test the trigger in the Zap editor to confirm the connection, and reconnect the Acme Cloud account in Zapier if the test fails.",
    updatedDay: 130,
  },
  // ---------- how-to ----------
  {
    slug: "role-based-permissions",
    title: "Setting up role-based permissions",
    body: "Custom roles let you choose exactly what members can see and do: create one under Settings → Roles, pick read-only or edit access per area, and assign it per project from the project's Members tab. Contractors can be given a read-only role on just the projects they need.\n\nIf you use SSO groups, you can map a group to a role so new members get it automatically.",
    updatedDay: 110,
  },
  {
    slug: "restrict-exports-admins",
    title: "Restricting data exports to admins",
    body: 'Under Settings → Security → Data exports, turn on "Only admins can export" to limit CSV and scheduled exports to workspace admins. The setting also applies to API keys created by non-admins.',
    updatedDay: 105,
  },
  {
    slug: "archive-projects",
    title: "Archiving old projects in bulk",
    body: "On the Projects page, filter by last activity, select the projects to archive with the checkboxes, and choose Archive from the bulk actions menu. Archived projects are read-only and can be restored at any time from the Archived tab.",
    updatedDay: 90,
  },
  {
    slug: "admin-audit-log",
    title: "Viewing the audit log of admin changes",
    body: "The audit log under Settings → Security → Audit log lists every admin change, sign-in and permission change with who made it and when. You can filter by member or action and export the log as CSV.",
    updatedDay: 85,
  },
];

const BASE_DAY = Date.UTC(2026, 0, 5);

export const demoArticleUrl = (slug: string) => `${DEMO_HELP_CENTER}/articles/${slug}`;
export const demoArticleUpdatedAt = (a: DemoArticle) => new Date(BASE_DAY + a.updatedDay * 86_400_000);

/**
 * The demo help desk's saved replies (T-47b): the macros its agents use, with
 * the help desk's own placeholders (stripped on sync, like a real connector).
 * They have no public page, so no URL.
 */
export interface DemoSavedReply {
  id: string;
  title: string;
  body: string;
  updatedDay: number;
}

export const DEMO_SAVED_REPLIES: DemoSavedReply[] = [
  {
    id: "macro-sso-audience",
    title: "SSO: SAML audience mismatch after an IdP change",
    body: "Hi {{ticket.requester.first_name}},\n\nThe audience mismatch error clears once the Audience URI in your identity provider matches the Entity ID under Settings → Security → Single sign-on exactly, including the trailing slash. Update it in Okta or Azure AD and ask one affected user to sign in again.\n\nIf it still fails, reply with a SAML trace and we will compare the assertion with your workspace settings.\n\n{{current_user.signature}}",
    updatedDay: 215,
  },
  {
    id: "macro-scim-reassign",
    title: "SCIM: users deactivated after enabling provisioning",
    body: "Hi {{ticket.requester.first_name}},\n\nWith SCIM provisioning on, users who are not assigned to the Acme Cloud app in your identity provider are deactivated at the next sync. Assign the affected users (or their group) to the app and run a push; they are reactivated with all their data intact.\n\n{{current_user.signature}}",
    updatedDay: 192,
  },
  {
    id: "macro-2fa-authenticator",
    title: "2FA codes by SMS not arriving: switch to an authenticator app",
    body: "Hi {{ticket.requester.first_name}},\n\nSome mobile carriers delay or filter SMS codes, especially for international numbers. Affected users can switch to an authenticator app under Profile → Security → Two-factor authentication, and an admin can reset a user's second factor from Settings → Members.\n\n{{current_user.signature}}",
    updatedDay: 165,
  },
  {
    id: "macro-api-500-request-ids",
    title: "API 500 errors: retry safely and send request IDs",
    body: "Hi {{ticket.requester.first_name}},\n\nSorry about the 500 errors. Please retry with exponential backoff and the same Idempotency-Key header, so no event is stored twice, and send us two or three request IDs (req_…) from the failing responses so our engineers can trace them.\n\n{{current_user.signature}}",
    updatedDay: 231,
  },
  {
    id: "macro-webhook-delays",
    title: "Webhook deliveries delayed: acknowledge first, process later",
    body: "Hi {{ticket.requester.first_name}},\n\nWebhook deliveries are retried with backoff when an endpoint takes longer than 10 seconds to answer, which makes later deliveries look delayed. Return a 2xx straight away and process the payload asynchronously; the delivery log under Settings → Developers → Webhooks shows each attempt and lets you replay failures.\n\n{{current_user.signature}}",
    updatedDay: 207,
  },
  {
    id: "macro-429-new-key",
    title: "Rate limit 429 errors below quota: create a new API key",
    body: "Hi {{ticket.requester.first_name}},\n\nA 429 below your plan's quota usually means the API key belongs to an older integration tier. Create a new key under Settings → Developers → API keys to get your plan's limit, and wait for the Retry-After seconds before retrying a 429.\n\n{{current_user.signature}}",
    updatedDay: 224,
  },
  {
    id: "macro-csv-export-async",
    title: "Large CSV export times out: use the background export",
    body: "Hi {{ticket.requester.first_name}},\n\nVery large CSV exports can time out in the browser. The background export under Settings → Data → Export runs on our side and emails you a download link when the file is ready, so it is the best option for a full history export.\n\n{{current_user.signature}}",
    updatedDay: 180,
  },
  {
    id: "macro-salesforce-reconnect",
    title: "Salesforce sync stopped updating: reconnect the integration",
    body: "Hi {{ticket.requester.first_name}},\n\nWhen Salesforce revokes the integration user's session (for example after a password reset), the sync stops updating opportunities while the page still says connected. Disconnect and reconnect Salesforce under Settings → Integrations with a user that has API access, then run a manual sync.\n\n{{current_user.signature}}",
    updatedDay: 198,
  },
  {
    id: "macro-slack-reinstall",
    title: "Slack notifications no longer posting: reinstall the Slack app",
    body: "Hi {{ticket.requester.first_name}},\n\nSlack notifications stop when the channel is archived or renamed, or when the person who installed the app leaves the workspace. Reinstall the Slack app from Settings → Integrations → Slack and pick the channel again.\n\n{{current_user.signature}}",
    updatedDay: 170,
  },
  {
    id: "macro-read-only-contractors",
    title: "Read-only access for contractors with role-based permissions",
    body: "Hi {{ticket.requester.first_name}},\n\nCreate a custom role under Settings → Roles with read-only access, then assign it to the contractors on just the projects they need from each project's Members tab. They will not see any other project.\n\n{{current_user.signature}}",
    updatedDay: 112,
  },
];

export const demoSavedReplyUpdatedAt = (r: DemoSavedReply) => new Date(BASE_DAY + r.updatedDay * 86_400_000);
