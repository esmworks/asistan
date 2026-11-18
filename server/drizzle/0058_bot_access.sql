ALTER TABLE "bots" ADD COLUMN "owner_user_id" text DEFAULT 'owner' NOT NULL;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "access" jsonb DEFAULT '{"everyone":"none","people":{}}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "user_id" text DEFAULT 'owner' NOT NULL;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "bots" ADD CONSTRAINT "bots_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "threads_user_idx" ON "threads" USING btree ("user_id","bot_id");--> statement-breakpoint
-- The conversations a person had are the owner's; the bots' own work (with each other, routines,
-- tickets) belongs to no one person.
UPDATE "threads" SET "user_id" = 'owner' WHERE "kind" IN ('user', 'room', 'api');
