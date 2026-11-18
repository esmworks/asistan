CREATE TABLE "channel_requests" (
	"channel_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"place" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_requests_channel_id_thread_id_pk" PRIMARY KEY("channel_id","thread_id")
);
--> statement-breakpoint
ALTER TABLE "channel_requests" ADD CONSTRAINT "channel_requests_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_requests" ADD CONSTRAINT "channel_requests_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;