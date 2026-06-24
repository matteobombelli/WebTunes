CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
ALTER TABLE "track_embeddings" ALTER COLUMN "embedding" SET DATA TYPE vector(512)
  USING replace(replace("embedding"::text, '{', '['), '}', ']')::vector(512);--> statement-breakpoint
CREATE INDEX "track_embeddings_embedding_idx" ON "track_embeddings" USING hnsw ("embedding" vector_cosine_ops);
