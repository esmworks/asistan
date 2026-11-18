CREATE TABLE "discord_threads" (
	"thread_id" text PRIMARY KEY NOT NULL,
	"server_id" text NOT NULL,
	"channel" text NOT NULL,
	"root_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "guest" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "discord_threads" ADD CONSTRAINT "discord_threads_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "discord_threads_uq" ON "discord_threads" USING btree ("channel","root_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channels_discord_uq" ON "channels" USING btree ("kind") WHERE "channels"."kind" = 'discord';