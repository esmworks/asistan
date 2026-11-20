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
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "routine_runs" ADD COLUMN "trigger_input" text;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "rehearsal_id" text;--> statement-breakpoint
ALTER TABLE "routine_rehearsals" ADD CONSTRAINT "routine_rehearsals_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_rehearsals" ADD CONSTRAINT "routine_rehearsals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_rehearsals" ADD CONSTRAINT "routine_rehearsals_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "routine_rehearsals_routine_idx" ON "routine_rehearsals" USING btree ("routine_id","created_at");