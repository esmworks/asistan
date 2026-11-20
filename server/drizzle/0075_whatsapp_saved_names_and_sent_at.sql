ALTER TABLE "whatsapp_chats" ADD COLUMN "saved_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "whatsapp_drafts" ADD COLUMN "sent_at" timestamp with time zone;