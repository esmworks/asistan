ALTER TABLE "approvals" ADD COLUMN "outside" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "routine_runs" ADD COLUMN "trigger" text;