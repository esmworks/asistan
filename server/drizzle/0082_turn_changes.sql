CREATE TABLE "turn_changes" (
	"id" text PRIMARY KEY NOT NULL,
	"turn_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"op" text NOT NULL,
	"target_id" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"scope_bot_id" text,
	"before" jsonb,
	"after" jsonb,
	"bytes" integer DEFAULT 0 NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"undone_at" timestamp with time zone,
	"outcome" text
);
--> statement-breakpoint
ALTER TABLE "turn_changes" ADD CONSTRAINT "turn_changes_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_changes" ADD CONSTRAINT "turn_changes_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_changes" ADD CONSTRAINT "turn_changes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "turn_changes_turn_idx" ON "turn_changes" USING btree ("turn_id","created_at");--> statement-breakpoint
CREATE INDEX "turn_changes_created_idx" ON "turn_changes" USING btree ("created_at");