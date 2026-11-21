-- Bots no longer take the felt plush shapes (`shape:<name>`): every one becomes the round object, the
-- avatar a new bot gets, and so does the column's default.
UPDATE "bots" SET "avatar" = 'object:circle' WHERE "avatar" LIKE 'shape:%';--> statement-breakpoint
ALTER TABLE "bots" ALTER COLUMN "avatar" SET DEFAULT 'object:circle';
