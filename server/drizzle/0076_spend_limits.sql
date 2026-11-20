ALTER TABLE "bots" ADD COLUMN "daily_limit_usd" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "monthly_limit_usd" double precision DEFAULT 0 NOT NULL;