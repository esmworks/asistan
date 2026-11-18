ALTER TABLE "memories" ADD COLUMN "place" text;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "pinned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_changes" ADD COLUMN "place" text;--> statement-breakpoint
CREATE INDEX "memories_place_idx" ON "memories" USING btree ("place");--> statement-breakpoint
-- A deleted note is forgotten: the history keeps who deleted it and when, but not its words.
-- Notes deleted before this release left their text in the history lines; clearing those columns
-- needs no decryption, so it works the same whether or not content sealing is on.
UPDATE "audit_log" SET "before" = NULL, "after" = NULL WHERE "target_type" = 'memory' AND "target_id" NOT IN (SELECT "id" FROM "memories");
