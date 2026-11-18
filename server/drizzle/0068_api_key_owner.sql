DROP INDEX "api_credentials_name_uq";--> statement-breakpoint
ALTER TABLE "api_credentials" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "api_credentials" ADD CONSTRAINT "api_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_credentials_name_user_uq" ON "api_credentials" USING btree ("name",coalesce("user_id", ''));