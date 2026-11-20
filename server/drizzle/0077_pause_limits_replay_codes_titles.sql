ALTER TABLE "bots" ADD COLUMN "paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "daily_limit_usd" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "monthly_limit_usd" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "email_addresses" ADD COLUMN "sign_in_codes" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "reply_files" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "steps" jsonb;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "title_auto" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "engine_session_tokens" integer;