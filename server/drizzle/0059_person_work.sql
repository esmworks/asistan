DROP INDEX "threads_peer_uq";--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "created_by_user_id" text;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "threads_peer_uq" ON "threads" USING btree ("bot_id","peer_bot_id","user_id") WHERE "threads"."kind" = 'bot';