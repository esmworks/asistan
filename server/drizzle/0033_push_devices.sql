CREATE TABLE "push_devices" (
	"token" text PRIMARY KEY NOT NULL,
	"platform" text NOT NULL,
	"session_id" text,
	"locale" text NOT NULL,
	"level" text NOT NULL,
	"mutes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sandbox" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
