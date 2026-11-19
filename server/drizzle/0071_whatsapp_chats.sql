CREATE TABLE "whatsapp_chats" (
	"jid" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"batched_seq" bigint DEFAULT 0 NOT NULL,
	"held_seq" bigint,
	"threads" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "whatsapp_drafts" (
	"id" text PRIMARY KEY NOT NULL,
	"approval_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"kind" text NOT NULL,
	"chat" text,
	"text" text DEFAULT '' NOT NULL,
	"file" text,
	"approve" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "whatsapp_messages" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"chat" text NOT NULL,
	"external_id" text NOT NULL,
	"from_me" boolean DEFAULT false NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"writer" text DEFAULT '' NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"file" jsonb,
	"at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "whatsapp_group" text;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "whatsapp_people" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "whatsapp_drafts" ADD CONSTRAINT "whatsapp_drafts_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_messages" ADD CONSTRAINT "whatsapp_messages_chat_whatsapp_chats_jid_fk" FOREIGN KEY ("chat") REFERENCES "public"."whatsapp_chats"("jid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_messages_chat_external_uq" ON "whatsapp_messages" USING btree ("chat","external_id");--> statement-breakpoint
CREATE INDEX "whatsapp_messages_at_idx" ON "whatsapp_messages" USING btree ("at");