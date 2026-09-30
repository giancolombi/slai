ALTER TYPE "public"."action_status" ADD VALUE 'sending' BEFORE 'sent';--> statement-breakpoint
ALTER TABLE "agent_actions" ADD COLUMN "send_attempt_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_actions" ADD COLUMN "sending_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_actions" ADD COLUMN "send_attempts" integer DEFAULT 0 NOT NULL;