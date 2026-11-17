-- Each instruction a routine has had, so an earlier one can be compared and brought back.
CREATE TABLE "routine_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"routine_id" text NOT NULL,
	"prompt" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "routine_revisions" ADD CONSTRAINT "routine_revisions_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "routine_revisions_routine_idx" ON "routine_revisions" USING btree ("routine_id","created_at");