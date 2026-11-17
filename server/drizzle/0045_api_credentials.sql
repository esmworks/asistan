-- API keys the person saved for bots to call services with; each value is sealed with the vault key.
CREATE TABLE "api_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"origin" text NOT NULL,
	"auth" jsonb NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"secret" text NOT NULL,
	"bot_ids" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "api_credentials_name_uq" ON "api_credentials" USING btree ("name");