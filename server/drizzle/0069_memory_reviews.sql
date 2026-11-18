CREATE TABLE "memory_reviews" (
	"thread_id" text PRIMARY KEY NOT NULL,
	"message_id" text NOT NULL,
	"message_at" timestamp with time zone NOT NULL,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memory_reviews" ADD CONSTRAINT "memory_reviews_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Conversations that exist when this comes in start from where they are: the review reads what is
-- written from now on, and an upgrade does not set off a review of every old conversation at once.
INSERT INTO "memory_reviews" ("thread_id", "message_id", "message_at")
SELECT DISTINCT ON ("thread_id") "thread_id", "id", "created_at" FROM "messages" ORDER BY "thread_id", "created_at" DESC, "id" DESC;
