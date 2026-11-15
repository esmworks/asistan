CREATE TABLE "vault_logins" (
	"id" text PRIMARY KEY NOT NULL,
	"site" text NOT NULL,
	"username" text NOT NULL,
	"secret" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "vault_logins_site_user_uq" ON "vault_logins" USING btree ("site","username");