-- Chat apps the person talks to bots through (Telegram, WhatsApp), which of their messages is which
-- message here, and the linked WhatsApp device's sealed keys.
CREATE TABLE "channel_messages" (
	"channel_id" text NOT NULL,
	"external_id" text NOT NULL,
	"message_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"bot_id" text,
	"secret" text,
	"account" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"owner" text,
	"owner_name" text,
	"pair_code" text,
	"pair_until" timestamp with time zone,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cursor" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "whatsapp_keys" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channel_messages" ADD CONSTRAINT "channel_messages_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_messages" ADD CONSTRAINT "channel_messages_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_messages_uq" ON "channel_messages" USING btree ("channel_id","external_id");--> statement-breakpoint
CREATE INDEX "channel_messages_message_idx" ON "channel_messages" USING btree ("message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channels_telegram_bot_uq" ON "channels" USING btree ("bot_id") WHERE "channels"."kind" = 'telegram';--> statement-breakpoint
CREATE UNIQUE INDEX "channels_whatsapp_uq" ON "channels" USING btree ("kind") WHERE "channels"."kind" = 'whatsapp';