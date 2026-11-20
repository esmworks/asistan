ALTER TABLE "memories" ADD COLUMN "valid_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memory_changes" ADD COLUMN "valid_until" timestamp with time zone;