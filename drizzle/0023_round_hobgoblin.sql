ALTER TABLE "listens" ADD COLUMN "session_id" uuid;--> statement-breakpoint
ALTER TABLE "listens" ADD COLUMN "listened_seconds" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "listens_session_id_idx" ON "listens" USING btree ("session_id");--> statement-breakpoint
ALTER TABLE "listens" ADD CONSTRAINT "listens_seconds_range" CHECK ("listens"."listened_seconds" IS NULL OR "listens"."listened_seconds" BETWEEN 30 AND 86400);