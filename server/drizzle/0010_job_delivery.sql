ALTER TABLE "jobs" ADD COLUMN "from_turn_id" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "delivered_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "jobs_from_turn_idx" ON "jobs" USING btree ("from_turn_id");