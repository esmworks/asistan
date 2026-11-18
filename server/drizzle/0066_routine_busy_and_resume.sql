ALTER TABLE "routine_runs" ADD COLUMN "busy_skips" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "resume_at" timestamp with time zone;