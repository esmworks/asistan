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
ALTER TABLE "payment_cards" ADD CONSTRAINT "payment_cards_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;