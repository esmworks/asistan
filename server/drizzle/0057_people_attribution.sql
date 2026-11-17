ALTER TABLE "approvals" ADD COLUMN "decided_by_user_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "created_by_user_id" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "created_by_user_id" text;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Everything a person did before there were people was the owner's doing.
UPDATE "messages" SET "user_id" = 'owner' WHERE "role" = 'user' AND "author" = 'user';--> statement-breakpoint
UPDATE "turns" SET "user_id" = 'owner' WHERE "source" IN ('user', 'reaction');--> statement-breakpoint
UPDATE "approvals" SET "decided_by_user_id" = 'owner' WHERE "decided_by" IN ('person', 'typed');--> statement-breakpoint
UPDATE "tickets" SET "created_by_user_id" = 'owner' WHERE "created_by" = 'user';--> statement-breakpoint
UPDATE "skills" SET "created_by_user_id" = 'owner';
