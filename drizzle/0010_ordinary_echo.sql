CREATE TABLE "track_embeddings" (
	"track_id" uuid PRIMARY KEY NOT NULL,
	"embedding" real[] NOT NULL
);
--> statement-breakpoint
ALTER TABLE "track_embeddings" ADD CONSTRAINT "track_embeddings_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE cascade ON UPDATE no action;