ALTER TABLE "routine_runs" ADD COLUMN "scheduled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "changed" boolean DEFAULT false NOT NULL;