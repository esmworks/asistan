-- Tickets keep the order the person gives them in a column; the newest stand first until moved.
ALTER TABLE "tickets" ADD COLUMN "position" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "tickets" SET "position" = -"number";
