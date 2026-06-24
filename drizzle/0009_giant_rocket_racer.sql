ALTER TABLE "tracks" ADD COLUMN "loudness_lufs" double precision;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "normalize_volume" boolean DEFAULT true NOT NULL;