CREATE TABLE "teams_people" (
	"teams_user_id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"service_url" text,
	"conversation_id" text,
	"bot_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "teams_people" ADD CONSTRAINT "teams_people_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams_people" ADD CONSTRAINT "teams_people_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "teams_people_user_uq" ON "teams_people" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channels_teams_uq" ON "channels" USING btree ("kind") WHERE "channels"."kind" = 'teams';