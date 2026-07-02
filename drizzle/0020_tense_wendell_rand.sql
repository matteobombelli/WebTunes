-- WebTunes Importer extension: pairing codes + import tokens (2026-07-02).
-- drizzle-kit generate also emitted the track_shares FK softening and
-- users.name NOT NULL here because those live only in the hand-applied
-- out-of-band files (0019_audit_indexes_and_share_fk.sql,
-- 0020_username_unique.sql), not in the snapshot journal. They were trimmed
-- from this file — the out-of-band files remain their source of record — and
-- the new snapshot now records them, so future generates stop re-emitting them.
CREATE TABLE "extension_pair_codes" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp NOT NULL,
	"used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "extension_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"label" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_used_at" timestamp,
	"revoked_at" timestamp,
	CONSTRAINT "extension_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "extension_pair_codes" ADD CONSTRAINT "extension_pair_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_tokens" ADD CONSTRAINT "extension_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "extension_tokens_user_id_idx" ON "extension_tokens" USING btree ("user_id");
