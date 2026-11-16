-- Memory changes bots ask for while nobody watches (routines, other bots' requests) wait here for the
-- person to accept or reject them.
CREATE TABLE "memory_changes" (
	"id" text PRIMARY KEY NOT NULL,
	"action" text NOT NULL,
	"memory_id" text,
	"scope" text NOT NULL,
	"bot_id" text,
	"site" text,
	"content" text NOT NULL,
	"before" text,
	"proposed_by" text NOT NULL,
	"origin" jsonb NOT NULL,
	"thread_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memory_changes" ADD CONSTRAINT "memory_changes_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_changes" ADD CONSTRAINT "memory_changes_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_changes" ADD CONSTRAINT "memory_changes_proposed_by_bots_id_fk" FOREIGN KEY ("proposed_by") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_changes_created_idx" ON "memory_changes" USING btree ("created_at");