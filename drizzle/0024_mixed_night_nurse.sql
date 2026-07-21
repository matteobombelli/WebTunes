CREATE TABLE "suggested_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"recording_mbid" uuid NOT NULL,
	"artist_mbid" uuid,
	"release_group_mbid" uuid,
	"title" text NOT NULL,
	"artist" text NOT NULL,
	"album" text,
	"duration_sec" integer,
	"art_url" text,
	"normalized_title" text NOT NULL,
	"normalized_artist" text NOT NULL,
	"reason" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"error" text,
	"rejected_until" timestamp,
	"lease_expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "suggested_imports_progress_range" CHECK ("suggested_imports"."progress" between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE "track_identities" (
	"track_id" uuid PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"acoustid_id" text,
	"recording_mbid" uuid,
	"artist_mbids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"release_group_mbid" uuid,
	"attempted_at" timestamp DEFAULT now() NOT NULL,
	"retry_after" timestamp
);
--> statement-breakpoint
ALTER TABLE "tracks" ADD COLUMN "suggested_import_id" uuid;--> statement-breakpoint
ALTER TABLE "suggested_imports" ADD CONSTRAINT "suggested_imports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "track_identities" ADD CONSTRAINT "track_identities_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "suggested_imports_user_recording_idx" ON "suggested_imports" USING btree ("user_id","recording_mbid");--> statement-breakpoint
CREATE INDEX "suggested_imports_user_status_idx" ON "suggested_imports" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "suggested_imports_status_lease_idx" ON "suggested_imports" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "track_identities_recording_idx" ON "track_identities" USING btree ("recording_mbid");--> statement-breakpoint
CREATE INDEX "track_identities_retry_idx" ON "track_identities" USING btree ("status","retry_after");--> statement-breakpoint
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_suggested_import_id_suggested_imports_id_fk" FOREIGN KEY ("suggested_import_id") REFERENCES "public"."suggested_imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_suggested_import_id_unique" UNIQUE("suggested_import_id");
