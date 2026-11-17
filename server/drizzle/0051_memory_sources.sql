-- Where a memory note came from: the conversation a bot wrote it in and the page it read the fact on.
ALTER TABLE "memories" ADD COLUMN "thread_id" text;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "source_url" text;--> statement-breakpoint
ALTER TABLE "memory_changes" ADD COLUMN "source_url" text;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action;