CREATE TABLE "whatsapp_saved_names" (
	"jid" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "whatsapp_messages" ADD COLUMN "awaiting" boolean DEFAULT false NOT NULL;