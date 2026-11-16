-- When a bot last looked a note up, and how often. The prompt keeps the notes in use when memory
-- outgrows it, and notes no bot has needed for a while can be offered to the user for deletion.
ALTER TABLE "memories" ADD COLUMN "last_used_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "use_count" integer DEFAULT 0 NOT NULL;