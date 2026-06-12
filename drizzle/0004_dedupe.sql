ALTER TABLE "tracks" ADD COLUMN "content_hash" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "hide_friend_duplicates" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "tracks_owner_content_hash_idx" ON "tracks" USING btree ("owner_id","content_hash");