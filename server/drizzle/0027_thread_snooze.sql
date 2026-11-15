ALTER TABLE "threads" ADD COLUMN "snoozed_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "pinned_at" timestamp with time zone;