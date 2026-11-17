ALTER TABLE "permission_rules" ADD COLUMN "bot_id" text;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "outside" text;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "mode_cap" text;--> statement-breakpoint
ALTER TABLE "permission_rules" ADD CONSTRAINT "permission_rules_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;