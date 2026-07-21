ALTER TABLE "listens" DROP CONSTRAINT "listens_seconds_range";--> statement-breakpoint
ALTER TABLE "listens" ALTER COLUMN "session_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "listens" ALTER COLUMN "listened_seconds" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "listens" ADD COLUMN "include_in_stats" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "listens" ADD CONSTRAINT "listens_stats_require_telemetry" CHECK (NOT "listens"."include_in_stats" OR ("listens"."session_id" IS NOT NULL AND "listens"."listened_seconds" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "listens" ADD CONSTRAINT "listens_seconds_range" CHECK ("listens"."listened_seconds" IS NULL OR "listens"."listened_seconds" BETWEEN 1 AND 86400);