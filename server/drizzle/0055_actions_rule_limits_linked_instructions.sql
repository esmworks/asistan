CREATE TABLE "bot_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"bot_id" text NOT NULL,
	"thread_id" text,
	"turn_id" text,
	"tool_name" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"how" text NOT NULL,
	"rule" text,
	"approval_id" text,
	"outside" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "decided_by" text;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "instructions_url" text;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "instructions_pending" text;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "instructions_doc_hash" text;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "instructions_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "instructions_error" text;--> statement-breakpoint
ALTER TABLE "permission_rules" ADD COLUMN "field" text;--> statement-breakpoint
ALTER TABLE "permission_rules" ADD COLUMN "limit_value" double precision;--> statement-breakpoint
ALTER TABLE "bot_actions" ADD CONSTRAINT "bot_actions_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_actions" ADD CONSTRAINT "bot_actions_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bot_actions_bot_idx" ON "bot_actions" USING btree ("bot_id","created_at");