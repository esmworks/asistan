-- Mail for bots: the addresses they receive at, their inboxes, and routines that run when mail arrives.
CREATE TABLE "email_addresses" (
	"name" text PRIMARY KEY NOT NULL,
	"bot_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "emails" (
	"id" text PRIMARY KEY NOT NULL,
	"bot_id" text NOT NULL,
	"to" text NOT NULL,
	"from" text NOT NULL,
	"from_name" text DEFAULT '' NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"message_id" text,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "email_trigger" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "email_filter" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "email_addresses" ADD CONSTRAINT "email_addresses_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emails" ADD CONSTRAINT "emails_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "emails_bot_idx" ON "emails" USING btree ("bot_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "emails_message_uq" ON "emails" USING btree ("bot_id","message_id") WHERE "emails"."message_id" is not null;