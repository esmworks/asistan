ALTER TABLE "routine_step_runs" ADD COLUMN "approval_id" text;--> statement-breakpoint
ALTER TABLE "routine_step_runs" ADD COLUMN "wait_until" timestamp with time zone;