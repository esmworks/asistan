ALTER TABLE "bots" ADD COLUMN "pinned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "bots" SET "pinned" = "is_manager";--> statement-breakpoint
UPDATE "bots" SET "position" = "ordered"."n" FROM (SELECT "id", row_number() OVER (ORDER BY "created_at") - 1 AS "n" FROM "bots") AS "ordered" WHERE "bots"."id" = "ordered"."id";
