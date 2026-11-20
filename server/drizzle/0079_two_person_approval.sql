ALTER TABLE "approvals" ADD COLUMN "needs_second" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "second_user_id" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "first_by_user_id" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "first_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bot_actions" ADD COLUMN "approved_by" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "permission_rules" ADD COLUMN "second_person" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "permission_rules" ADD COLUMN "second_user_id" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_first_by_user_id_users_id_fk" FOREIGN KEY ("first_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;