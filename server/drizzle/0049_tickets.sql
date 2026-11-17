-- The board: tickets the person and the bots work from, with their comments.
CREATE TABLE "ticket_comments" (
	"id" text PRIMARY KEY NOT NULL,
	"ticket_id" text NOT NULL,
	"author" text NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" text PRIMARY KEY NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'todo' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"assignee_bot_id" text,
	"created_by" text NOT NULL,
	"thread_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ticket_comments" ADD CONSTRAINT "ticket_comments_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_assignee_bot_id_bots_id_fk" FOREIGN KEY ("assignee_bot_id") REFERENCES "public"."bots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ticket_comments_ticket_idx" ON "ticket_comments" USING btree ("ticket_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tickets_number_uq" ON "tickets" USING btree ("number");--> statement-breakpoint
CREATE INDEX "tickets_status_idx" ON "tickets" USING btree ("status");