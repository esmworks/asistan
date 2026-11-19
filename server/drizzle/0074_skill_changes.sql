CREATE TABLE "skill_changes" (
	"id" text PRIMARY KEY NOT NULL,
	"skill_id" text NOT NULL,
	"description" text NOT NULL,
	"body" text NOT NULL,
	"reason" text,
	"proposed_by" text NOT NULL,
	"user_id" text,
	"thread_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "uses" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "last_used_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "skill_changes" ADD CONSTRAINT "skill_changes_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_changes" ADD CONSTRAINT "skill_changes_proposed_by_bots_id_fk" FOREIGN KEY ("proposed_by") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_changes" ADD CONSTRAINT "skill_changes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "skill_changes_skill_idx" ON "skill_changes" USING btree ("skill_id");