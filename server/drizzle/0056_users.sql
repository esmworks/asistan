CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"username" text,
	"username_key" text,
	"display_name" text,
	"role" text NOT NULL,
	"password" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_key_uq" ON "users" USING btree ("username_key");--> statement-breakpoint
CREATE UNIQUE INDEX "users_one_owner_uq" ON "users" USING btree ("role") WHERE "users"."role" = 'owner';--> statement-breakpoint
-- The owner stands for whoever runs this server today. The username and password move over from the
-- old single account at startup (users.ts, adoptLegacyAccount), in one place for this and a restore.
INSERT INTO "users" ("id", "role") VALUES ('owner', 'owner');--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "user_id" text;--> statement-breakpoint
UPDATE "sessions" SET "user_id" = 'owner';--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
-- Added last, after the rows are filled. Deferrable so a restore, which replaces the users while the
-- sessions stay, can check it once at the end instead of row by row.
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY IMMEDIATE;
