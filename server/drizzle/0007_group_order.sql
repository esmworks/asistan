ALTER TABLE "groups" ADD COLUMN "position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "groups" SET "position" = "ordered"."n" FROM (SELECT "id", row_number() OVER (ORDER BY "created_at") - 1 AS "n" FROM "groups") AS "ordered" WHERE "groups"."id" = "ordered"."id";
