-- Notes no longer wait for the user's approval: a bot writes, changes and deletes its memory itself.
-- Dropping the column keeps every note, so the ones that were waiting become memory the bot sees and
-- can clean up.
ALTER TABLE "memories" DROP COLUMN "status";
