ALTER TABLE "bots" ADD COLUMN "paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "paused_at" timestamp with time zone;