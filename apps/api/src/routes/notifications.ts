import { AAD, audit, decrypt, encrypt, notificationChannels } from "@slai/db";
import { type NotificationChannel, notificationChannelBody } from "@slai/shared";
import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { type AppDeps, type AppEnv, auditBase, auth } from "../context.js";
import { badRequest, notFound } from "../errors.js";
import { requireRole } from "../middleware/auth.js";
import { body, idParam } from "../validate.js";

type Row = typeof notificationChannels.$inferSelect;
const SLACK = /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+$/;

function validateTarget(kind: Row["kind"], target: string) {
  if (kind === "email" && !z.email().safeParse(target).success) throw badRequest("Enter a valid email address.");
  if (kind === "slack_webhook" && !SLACK.test(target))
    throw badRequest("Enter a Slack incoming webhook URL (https://hooks.slack.com/services/...).");
}

export function notificationRoutes(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  /** Slack webhook URLs are secrets: stored encrypted and only ever returned masked. */
  const toDto = (r: Row): NotificationChannel => {
    let target = r.target;
    if (r.kind === "slack_webhook") {
      let tail = "";
      try {
        tail = decrypt(r.target, { keyring: deps.keyring, aad: AAD.notificationTarget(r.id) }).slice(-4);
      } catch {}
      target = `https://hooks.slack.com/services/…${tail}`;
    }
    return { id: r.id, kind: r.kind, target, minRisk: r.minRisk, enabled: r.enabled };
  };
  const stored = (id: string, kind: Row["kind"], target: string) =>
    kind === "slack_webhook" ? encrypt(target, { keyring: deps.keyring, aad: AAD.notificationTarget(id) }) : target;

  app.get("/", async (c) => {
    const rows = await deps.orgDb.withOrg(auth(c).orgId, (tx) =>
      tx.select().from(notificationChannels).orderBy(asc(notificationChannels.createdAt)),
    );
    return c.json(rows.map(toDto));
  });

  app.post("/", requireRole("admin"), async (c) => {
    const a = auth(c);
    const input = await body(c, notificationChannelBody);
    validateTarget(input.kind, input.target);
    const id = crypto.randomUUID();
    const row = await deps.orgDb.withOrg(a.orgId, async (tx) => {
      const [r] = await tx
        .insert(notificationChannels)
        .values({
          id,
          orgId: a.orgId,
          kind: input.kind,
          target: stored(id, input.kind, input.target),
          minRisk: input.minRisk,
          enabled: input.enabled,
        })
        .returning();
      await audit(tx, {
        ...auditBase(c),
        orgId: a.orgId,
        action: "notification_channel.created",
        target: { type: "notification_channel", id },
        metadata: { kind: input.kind },
      });
      return r!;
    });
    return c.json(toDto(row), 201);
  });

  app.patch("/:id", requireRole("admin"), async (c) => {
    const a = auth(c);
    const id = idParam(c, "id", "Notification channel");
    const input = await body(c, notificationChannelBody.partial());
    const row = await deps.orgDb.withOrg(a.orgId, async (tx) => {
      const [cur] = await tx.select().from(notificationChannels).where(eq(notificationChannels.id, id));
      if (!cur) throw notFound("Notification channel");
      const kind = input.kind ?? cur.kind;
      if (input.kind !== undefined && input.kind !== cur.kind && input.target === undefined) {
        throw badRequest("Changing the kind requires a new target.");
      }
      if (input.target !== undefined) validateTarget(kind, input.target);
      const [r] = await tx
        .update(notificationChannels)
        .set({
          kind,
          ...(input.target !== undefined && { target: stored(id, kind, input.target) }),
          ...(input.minRisk !== undefined && { minRisk: input.minRisk }),
          ...(input.enabled !== undefined && { enabled: input.enabled }),
        })
        .where(eq(notificationChannels.id, id))
        .returning();
      await audit(tx, {
        ...auditBase(c),
        orgId: a.orgId,
        action: "notification_channel.updated",
        target: { type: "notification_channel", id },
        metadata: { fields: Object.keys(input) },
      });
      return r!;
    });
    return c.json(toDto(row));
  });

  app.delete("/:id", requireRole("admin"), async (c) => {
    const a = auth(c);
    const id = idParam(c, "id", "Notification channel");
    await deps.orgDb.withOrg(a.orgId, async (tx) => {
      const [r] = await tx
        .delete(notificationChannels)
        .where(eq(notificationChannels.id, id))
        .returning({ kind: notificationChannels.kind });
      if (!r) throw notFound("Notification channel");
      await audit(tx, {
        ...auditBase(c),
        orgId: a.orgId,
        action: "notification_channel.deleted",
        target: { type: "notification_channel", id },
        metadata: r,
      });
    });
    return c.body(null, 204);
  });

  return app;
}
