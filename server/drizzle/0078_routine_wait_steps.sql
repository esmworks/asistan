ALTER TABLE "routine_runs" ADD COLUMN "vars" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "routine_step_runs" ADD COLUMN "filter" text;--> statement-breakpoint
ALTER TABLE "routine_step_runs" ADD COLUMN "event_id" text;