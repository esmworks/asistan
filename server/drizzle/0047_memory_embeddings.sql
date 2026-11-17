-- Notes keep their meaning as numbers, for search by meaning with the embedding service the person sets.
ALTER TABLE "memories" ADD COLUMN "embedding" real[];--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "embedding_key" text;