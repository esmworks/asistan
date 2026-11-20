CREATE TABLE "work_offer_checks" (
	"id" text PRIMARY KEY NOT NULL,
	"bot_id" text NOT NULL,
	"cost_usd" real,
	"found" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "work_offer_checks" ADD CONSTRAINT "work_offer_checks_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "work_offer_checks_created_idx" ON "work_offer_checks" USING btree ("created_at");