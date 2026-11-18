ALTER TABLE "audit_log" ADD COLUMN "owner" text;--> statement-breakpoint
-- Lines about notes still here say whose they are; those of deleted notes stay the owner's.
UPDATE "audit_log" SET "owner" = CASE WHEN m."scope" = 'user' THEN 'user:' || coalesce(m."user_id", 'owner') ELSE 'bot:' || m."bot_id" END FROM "memories" m WHERE "audit_log"."target_type" = 'memory' AND "audit_log"."target_id" = m."id";
