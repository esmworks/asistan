CREATE TABLE "routine_step_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"position" integer NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"output" text,
	"reason" text,
	"turn_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "routine_runs" ADD COLUMN "steps_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "routine_runs" ADD COLUMN "step_model" text;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "steps" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "routine_step_runs" ADD CONSTRAINT "routine_step_runs_run_id_routine_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."routine_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "routine_step_runs_position_uq" ON "routine_step_runs" USING btree ("run_id","position");