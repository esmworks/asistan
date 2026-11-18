CREATE TABLE "slack_people" (
	"slack_user_id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"dm_channel" text,
	"bot_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slack_threads" (
	"thread_id" text PRIMARY KEY NOT NULL,
	"channel" text NOT NULL,
	"thread_ts" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "slack_people" ADD CONSTRAINT "slack_people_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_people" ADD CONSTRAINT "slack_people_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_threads" ADD CONSTRAINT "slack_threads_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "slack_people_user_uq" ON "slack_people" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "slack_threads_uq" ON "slack_threads" USING btree ("channel","thread_ts");--> statement-breakpoint
CREATE UNIQUE INDEX "channels_slack_uq" ON "channels" USING btree ("kind") WHERE "channels"."kind" = 'slack';