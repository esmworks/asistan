CREATE TABLE "canary_alarms" (
	"id" text PRIMARY KEY NOT NULL,
	"wire" text NOT NULL,
	"bot_id" text NOT NULL,
	"thread_id" text,
	"turn_id" text,
	"user_id" text,
	"tool" text NOT NULL,
	"key_name" text,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"moved_from" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"seen_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "api_credentials" ADD COLUMN "trap" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "canary_alarms" ADD CONSTRAINT "canary_alarms_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canary_alarms" ADD CONSTRAINT "canary_alarms_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canary_alarms" ADD CONSTRAINT "canary_alarms_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "canary_alarms_open_idx" ON "canary_alarms" USING btree ("seen_at","created_at");