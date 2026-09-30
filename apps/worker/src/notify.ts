/**
 * Outbound alerts: email (SMTP; Mailpit locally) and Slack incoming webhooks.
 * Every delivery (or failure) is recorded as an audit event, since it sends
 * data outside slai. Slack webhook URLs are decrypted just in time and never
 * logged or recorded.
 */
import { AAD, audit, decrypt, notificationChannels } from "@slai/db";
import { eq } from "drizzle-orm";
import { createTransport } from "nodemailer";
import type { WorkerDeps } from "./deps.js";
import { errorMessage } from "./logger.js";

export interface Mailer {
  send(msg: { to: string; subject: string; text: string }): Promise<void>;
}

export function smtpMailer(url: string, from: string): Mailer {
  const transport = createTransport(url);
  return {
    async send(msg) {
      await transport.sendMail({ from, ...msg });
    },
  };
}

export interface Channel {
  id: string;
  kind: "email" | "slack_webhook";
  target: string;
}

export interface Message {
  subject: string;
  text: string;
}

async function deliver(deps: WorkerDeps, ch: Channel, msg: Message): Promise<void> {
  if (ch.kind === "email") {
    await deps.mailer.send({ to: ch.target, subject: msg.subject, text: msg.text });
    return;
  }
  const url = decrypt(ch.target, { keyring: deps.keyring, aad: AAD.notificationTarget(ch.id) });
  if (!url.startsWith("https://hooks.slack.com/")) throw new Error("not a Slack webhook URL");
  const res = await deps.fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: `*${msg.subject}*\n${msg.text}` }),
  });
  if (!res.ok) throw new Error(`Slack webhook returned ${res.status}`);
}

/**
 * Sends `msg` to each channel and records the outcome. Runs after the
 * transaction that decided to notify has committed.
 */
export async function sendNotifications(
  deps: WorkerDeps,
  orgId: string,
  channels: Channel[],
  msg: Message,
  record: { target: { type: string; id: string | null }; metadata: Record<string, unknown> },
): Promise<void> {
  for (const ch of channels) {
    let error: string | null = null;
    try {
      await deliver(deps, ch, msg);
    } catch (e) {
      error = errorMessage(e);
      deps.logger.warn({ orgId, channelId: ch.id, kind: ch.kind, err: error }, "notification failed");
    }
    await deps.orgDb.withOrg(orgId, (tx) =>
      audit(tx, {
        orgId,
        actor: { type: "system", id: null, name: "slai" },
        action: error ? "notification.failed" : "notification.sent",
        target: record.target,
        metadata: { ...record.metadata, channelId: ch.id, channelKind: ch.kind, ...(error && { error }) },
      }),
    );
  }
}

export async function enabledChannels(tx: Parameters<Parameters<WorkerDeps["orgDb"]["withOrg"]>[1]>[0]) {
  return tx.select().from(notificationChannels).where(eq(notificationChannels.enabled, true));
}
