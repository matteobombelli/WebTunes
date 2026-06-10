ALTER TABLE "tracks" ADD COLUMN "search_vector" tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('simple', coalesce("title", '')), 'A') ||
  setweight(to_tsvector('simple', coalesce("artist", '')), 'A') ||
  setweight(to_tsvector('simple', coalesce("album", '')), 'B') ||
  setweight(to_tsvector('simple', coalesce("lyrics", '')), 'C')
) STORED;--> statement-breakpoint
CREATE INDEX "tracks_search_vector_idx" ON "tracks" USING gin ("search_vector");
