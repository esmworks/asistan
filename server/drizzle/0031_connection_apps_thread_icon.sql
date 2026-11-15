ALTER TABLE "connections" ADD COLUMN "show_apps" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "icon" text DEFAULT '' NOT NULL;