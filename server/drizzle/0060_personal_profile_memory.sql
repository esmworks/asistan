ALTER TABLE "memories" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "memory_changes" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "profile" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
-- Notes about the person, and waiting changes, from before people came in were the owner's.
UPDATE "memories" SET "user_id"='owner' WHERE "scope"='user';--> statement-breakpoint
UPDATE "memory_changes" SET "user_id"='owner';--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_changes" ADD CONSTRAINT "memory_changes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memories_user_idx" ON "memories" USING btree ("user_id");