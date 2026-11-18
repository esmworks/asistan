DROP INDEX "vault_logins_site_user_uq";--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "vault_logins" ADD COLUMN "user_id" text;--> statement-breakpoint
-- What was set up before people came in was the owner's own.
UPDATE "connections" SET "user_id"='owner';--> statement-breakpoint
UPDATE "vault_logins" SET "user_id"='owner';--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_logins" ADD CONSTRAINT "vault_logins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "vault_logins_site_user_uq" ON "vault_logins" USING btree ("site","username",coalesce("user_id", ''));