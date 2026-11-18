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
CREATE TABLE "payment_cards" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"label" text DEFAULT '' NOT NULL,
	"brand" text NOT NULL,
	"last4" text NOT NULL,
	"exp_month" integer NOT NULL,
	"exp_year" integer NOT NULL,
	"secret" text NOT NULL,
	"has_cvc" boolean DEFAULT false NOT NULL,
	"sites" text,
	"bot_ids" jsonb,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "api_credentials_name_uq";--> statement-breakpoint
ALTER TABLE "api_credentials" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "password_managers" ADD CONSTRAINT "password_managers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_cards" ADD CONSTRAINT "payment_cards_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "password_managers_kind_user_uq" ON "password_managers" USING btree ("kind",coalesce("user_id", ''));--> statement-breakpoint
ALTER TABLE "api_credentials" ADD CONSTRAINT "api_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_credentials_name_user_uq" ON "api_credentials" USING btree ("name",coalesce("user_id", ''));