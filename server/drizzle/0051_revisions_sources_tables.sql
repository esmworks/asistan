-- A routine's earlier instructions, where a memory note came from, and the tables bots keep.
CREATE TABLE "bot_table_rows" (
	"id" text PRIMARY KEY NOT NULL,
	"table_id" text NOT NULL,
	"values" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bot_tables" (
	"id" text PRIMARY KEY NOT NULL,
	"bot_id" text NOT NULL,
	"name" text NOT NULL,
	"columns" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "routine_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"routine_id" text NOT NULL,
	"prompt" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "thread_id" text;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "source_url" text;--> statement-breakpoint
ALTER TABLE "memory_changes" ADD COLUMN "source_url" text;--> statement-breakpoint
ALTER TABLE "bot_table_rows" ADD CONSTRAINT "bot_table_rows_table_id_bot_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."bot_tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_tables" ADD CONSTRAINT "bot_tables_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_revisions" ADD CONSTRAINT "routine_revisions_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bot_table_rows_table_idx" ON "bot_table_rows" USING btree ("table_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "bot_tables_name_uq" ON "bot_tables" USING btree ("bot_id","name");--> statement-breakpoint
CREATE INDEX "routine_revisions_routine_idx" ON "routine_revisions" USING btree ("routine_id","created_at");--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action;