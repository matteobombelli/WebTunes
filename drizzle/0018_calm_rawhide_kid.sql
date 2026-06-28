CREATE TABLE "track_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"track_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	CONSTRAINT "track_shares_track_id_unique" UNIQUE("track_id"),
	CONSTRAINT "track_shares_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "track_shares" ADD CONSTRAINT "track_shares_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "track_shares" ADD CONSTRAINT "track_shares_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "track_shares_expires_at_idx" ON "track_shares" USING btree ("expires_at");