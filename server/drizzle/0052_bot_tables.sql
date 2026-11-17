-- Bots' tables: records a bot keeps in rows and columns for the person to read, correct and export.
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
ALTER TABLE "bot_table_rows" ADD CONSTRAINT "bot_table_rows_table_id_bot_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."bot_tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_tables" ADD CONSTRAINT "bot_tables_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bot_table_rows_table_idx" ON "bot_table_rows" USING btree ("table_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "bot_tables_name_uq" ON "bot_tables" USING btree ("bot_id","name");