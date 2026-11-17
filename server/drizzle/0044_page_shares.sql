-- Links that open a bot's page for anyone who has them, without signing in.
CREATE TABLE "page_shares" (
	"token" text PRIMARY KEY NOT NULL,
	"bot_id" text NOT NULL,
	"path" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "page_shares" ADD CONSTRAINT "page_shares_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "page_shares_page_uq" ON "page_shares" USING btree ("bot_id","path");