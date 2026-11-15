ALTER TABLE "connections" ADD COLUMN "all_bots" boolean DEFAULT true NOT NULL;--> statement-breakpoint
-- Connections made before this keep the bots they were turned on for, so none gains bots on upgrade.
UPDATE "connections" SET "all_bots" = false;
