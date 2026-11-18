CREATE TABLE "password_managers" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"kind" text NOT NULL,
	"scope" text DEFAULT '' NOT NULL,
	"server" text,
	"secret" text NOT NULL,
	"bot_ids" jsonb,
	"problem" text,
	"count" integer,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "password_managers" ADD CONSTRAINT "password_managers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "password_managers_kind_user_uq" ON "password_managers" USING btree ("kind",coalesce("user_id", ''));