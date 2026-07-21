-- Start analytics from a clean boundary. This removes both the legacy
-- playhead-based rows and the brief interim telemetry that still used the
-- previous 30-second qualification rule.
DELETE FROM "listens";--> statement-breakpoint
-- This denormalized counter represented the deleted history too.
UPDATE "tracks" SET "friend_play_count" = 0
WHERE "friend_play_count" <> 0;--> statement-breakpoint
ALTER TABLE "listens" DROP CONSTRAINT "listens_seconds_range";--> statement-breakpoint
ALTER TABLE "listens" ALTER COLUMN "session_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "listens" ALTER COLUMN "listened_seconds" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "listens" ADD CONSTRAINT "listens_seconds_range" CHECK ("listens"."listened_seconds" BETWEEN 1 AND 86400);
