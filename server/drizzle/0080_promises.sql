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
ALTER TABLE "promise_checks" ADD CONSTRAINT "promise_checks_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promises" ADD CONSTRAINT "promises_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promises" ADD CONSTRAINT "promises_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promises" ADD CONSTRAINT "promises_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promises" ADD CONSTRAINT "promises_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "promise_checks_created_idx" ON "promise_checks" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "promises_user_status_idx" ON "promises" USING btree ("user_id","status");