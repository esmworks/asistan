CREATE TABLE "routine_suggestion_checks" (
	"id" text PRIMARY KEY NOT NULL,
	"bot_id" text NOT NULL,
	"cost_usd" real,
	"found" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "routine_suggestions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"name" text NOT NULL,
	"instructions" text NOT NULL,
	"schedule" jsonb,
	"timezone" text NOT NULL,
	"requests" integer NOT NULL,
	"days" jsonb NOT NULL,
	"fingerprint" text NOT NULL,
	"signature" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"routine_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "routine_suggestion_checks" ADD CONSTRAINT "routine_suggestion_checks_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_suggestions" ADD CONSTRAINT "routine_suggestions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_suggestions" ADD CONSTRAINT "routine_suggestions_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_suggestions" ADD CONSTRAINT "routine_suggestions_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "routine_suggestion_checks_created_idx" ON "routine_suggestion_checks" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "routine_suggestions_user_status_idx" ON "routine_suggestions" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "routine_suggestions_fingerprint_uq" ON "routine_suggestions" USING btree ("user_id","bot_id","fingerprint");