CREATE TABLE "canary_alarms" (
	"id" text PRIMARY KEY NOT NULL,
	"wire" text NOT NULL,
	"bot_id" text NOT NULL,
	"thread_id" text,
	"turn_id" text,
	"user_id" text,
	"tool" text NOT NULL,
	"key_name" text,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"moved_from" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"seen_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "promise_checks" (
	"id" text PRIMARY KEY NOT NULL,
	"bot_id" text NOT NULL,
	"cost_usd" real,
	"found" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "promises" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"thread_id" text,
	"made_by" text NOT NULL,
	"text" text NOT NULL,
	"to_whom" text DEFAULT '' NOT NULL,
	"due_at" timestamp with time zone,
	"due_has_time" boolean DEFAULT false NOT NULL,
	"condition" text DEFAULT '' NOT NULL,
	"routine_id" text,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "routine_rehearsals" (
	"id" text PRIMARY KEY NOT NULL,
	"routine_id" text NOT NULL,
	"user_id" text NOT NULL,
	"thread_id" text,
	"turn_id" text,
	"draft" boolean DEFAULT false NOT NULL,
	"replay_run_id" text,
	"prompt" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"report" text DEFAULT '' NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"cost_usd" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"pruned_at" timestamp with time zone
);
--> statement-breakpoint
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
CREATE TABLE "turn_changes" (
	"id" text PRIMARY KEY NOT NULL,
	"turn_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"op" text NOT NULL,
	"target_id" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"scope_bot_id" text,
	"before" jsonb,
	"after" jsonb,
	"bytes" integer DEFAULT 0 NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"undone_at" timestamp with time zone,
	"outcome" text
);
--> statement-breakpoint
ALTER TABLE "api_credentials" ADD COLUMN "trap" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "needs_second" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "second_user_id" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "first_by_user_id" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "first_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bot_actions" ADD COLUMN "approved_by" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "valid_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memory_changes" ADD COLUMN "valid_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "permission_rules" ADD COLUMN "second_person" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "permission_rules" ADD COLUMN "second_user_id" text;--> statement-breakpoint
ALTER TABLE "routine_runs" ADD COLUMN "trigger_input" text;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "rehearsal_id" text;--> statement-breakpoint
ALTER TABLE "canary_alarms" ADD CONSTRAINT "canary_alarms_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canary_alarms" ADD CONSTRAINT "canary_alarms_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canary_alarms" ADD CONSTRAINT "canary_alarms_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promise_checks" ADD CONSTRAINT "promise_checks_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promises" ADD CONSTRAINT "promises_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promises" ADD CONSTRAINT "promises_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promises" ADD CONSTRAINT "promises_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promises" ADD CONSTRAINT "promises_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_rehearsals" ADD CONSTRAINT "routine_rehearsals_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_rehearsals" ADD CONSTRAINT "routine_rehearsals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_rehearsals" ADD CONSTRAINT "routine_rehearsals_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_suggestion_checks" ADD CONSTRAINT "routine_suggestion_checks_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_suggestions" ADD CONSTRAINT "routine_suggestions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_suggestions" ADD CONSTRAINT "routine_suggestions_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_suggestions" ADD CONSTRAINT "routine_suggestions_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_changes" ADD CONSTRAINT "turn_changes_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_changes" ADD CONSTRAINT "turn_changes_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_changes" ADD CONSTRAINT "turn_changes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "canary_alarms_open_idx" ON "canary_alarms" USING btree ("seen_at","created_at");--> statement-breakpoint
CREATE INDEX "promise_checks_created_idx" ON "promise_checks" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "promises_user_status_idx" ON "promises" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "routine_rehearsals_routine_idx" ON "routine_rehearsals" USING btree ("routine_id","created_at");--> statement-breakpoint
CREATE INDEX "routine_suggestion_checks_created_idx" ON "routine_suggestion_checks" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "routine_suggestions_user_status_idx" ON "routine_suggestions" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "routine_suggestions_fingerprint_uq" ON "routine_suggestions" USING btree ("user_id","bot_id","fingerprint");--> statement-breakpoint
CREATE INDEX "turn_changes_turn_idx" ON "turn_changes" USING btree ("turn_id","created_at");--> statement-breakpoint
CREATE INDEX "turn_changes_created_idx" ON "turn_changes" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_first_by_user_id_users_id_fk" FOREIGN KEY ("first_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;