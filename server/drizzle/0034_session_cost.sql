ALTER TABLE "room_members" ADD COLUMN "engine_session_cost_usd" double precision;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "engine_session_cost_usd" double precision;--> statement-breakpoint
-- Claude reports the running total of a resumed session, and turns stored that total as their own
-- cost. Each session's last total is kept as its starting point, then every Claude turn is repriced
-- as what it added to the turn before it in the same conversation. Turns keep no session id, so a
-- total lower than the one before means the count started over and is kept as it is.
UPDATE "threads" SET "engine_session_cost_usd" = (
  SELECT t."cost_usd" FROM "turns" t
  WHERE t."thread_id" = "threads"."id" AND t."bot_id" = "threads"."bot_id"
    AND t."engine" = 'claude' AND t."cost_usd" IS NOT NULL AND t."finished_at" IS NOT NULL
  ORDER BY t."finished_at" DESC LIMIT 1
) WHERE "engine_session_id" IS NOT NULL;--> statement-breakpoint
UPDATE "room_members" SET "engine_session_cost_usd" = (
  SELECT t."cost_usd" FROM "turns" t
  WHERE t."thread_id" = "room_members"."room_id" AND t."bot_id" = "room_members"."bot_id"
    AND t."engine" = 'claude' AND t."cost_usd" IS NOT NULL AND t."finished_at" IS NOT NULL
  ORDER BY t."finished_at" DESC LIMIT 1
) WHERE "engine_session_id" IS NOT NULL;--> statement-breakpoint
UPDATE "turns" SET "cost_usd" = d."cost" FROM (
  SELECT "id", CASE WHEN "before" IS NOT NULL AND "cost_usd" >= "before" THEN "cost_usd" - "before" ELSE "cost_usd" END AS "cost"
  FROM (
    SELECT "id", "cost_usd",
      lag("cost_usd") OVER (PARTITION BY "thread_id", "bot_id" ORDER BY "finished_at", "created_at") AS "before"
    FROM "turns"
    WHERE "engine" = 'claude' AND "cost_usd" IS NOT NULL AND "finished_at" IS NOT NULL
  ) s
) d WHERE "turns"."id" = d."id";
