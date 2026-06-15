import {
  pgTable,
  text,
  timestamp,
  integer,
  uuid,
  primaryKey,
  uniqueIndex,
  index,
  check,
  boolean,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { AdapterAccountType } from "next-auth/adapters";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name"),
  email: text("email").notNull().unique(),
  emailVerified: timestamp("email_verified", { mode: "date" }),
  image: text("image"),
  passwordHash: text("password_hash").notNull(),
  hideFriendDuplicates: boolean("hide_friend_duplicates")
    .notNull()
    .default(true),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
});

export const accounts = pgTable(
  "accounts",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").$type<AdapterAccountType>().notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (account) => [
    primaryKey({ columns: [account.provider, account.providerAccountId] }),
  ]
);

export const sessions = pgTable("sessions", {
  sessionToken: text("session_token").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { mode: "date" }).notNull(),
});

export const verificationTokens = pgTable(
  "verification_tokens",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { mode: "date" }).notNull(),
  },
  (vt) => [primaryKey({ columns: [vt.identifier, vt.token] })]
);

export const passwordResetTokens = pgTable("password_reset_tokens", {
  tokenHash: text("token_hash").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { mode: "date" }).notNull(),
  usedAt: timestamp("used_at", { mode: "date" }),
});

export const tracks = pgTable(
  "tracks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    artist: text("artist"),
    album: text("album"),
    durationSec: integer("duration_sec"),
    s3Key: text("s3_key").notNull().unique(),
    // S3 key of embedded cover art extracted on upload; null when none.
    artS3Key: text("art_s3_key"),
    mimeType: text("mime_type"),
    fileSize: integer("file_size"),
    // sha256 of the file bytes; null for tracks uploaded before dedupe.
    contentHash: text("content_hash"),
    lyrics: text("lyrics"),
    lyricsSource: text("lyrics_source", {
      enum: ["embedded", "lrclib", "none"],
    })
      .notNull()
      .default("none"),
    isPrivate: boolean("is_private").notNull().default(false),
    // Times a non-owner played this track to ≥30s (the "friend play count").
    friendPlayCount: integer("friend_play_count").notNull().default(0),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    // search_vector tsvector generated column + GIN index added via raw SQL
    // in the migration (drizzle has no native tsvector type).
  },
  (t) => [
    index("tracks_owner_id_idx").on(t.ownerId),
    // Same file can't enter the same library twice (legacy NULL hashes exempt).
    uniqueIndex("tracks_owner_content_hash_idx").on(t.ownerId, t.contentHash),
  ]
);

export const friendships = pgTable(
  "friendships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requesterId: uuid("requester_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    addresseeId: uuid("addressee_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["pending", "accepted"] })
      .notNull()
      .default("pending"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    respondedAt: timestamp("responded_at", { mode: "date" }),
  },
  (f) => [
    uniqueIndex("friendships_pair_idx").on(f.requesterId, f.addresseeId),
    check("friendships_no_self", sql`${f.requesterId} <> ${f.addresseeId}`),
  ]
);

export const playlists = pgTable("playlists", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  coverS3Key: text("cover_s3_key"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
});

export const playlistTracks = pgTable(
  "playlist_tracks",
  {
    playlistId: uuid("playlist_id")
      .notNull()
      .references(() => playlists.id, { onDelete: "cascade" }),
    trackId: uuid("track_id")
      .notNull()
      .references(() => tracks.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
  },
  (pt) => [
    primaryKey({ columns: [pt.playlistId, pt.trackId] }),
    index("playlist_tracks_position_idx").on(pt.playlistId, pt.position),
  ]
);

export type Track = typeof tracks.$inferSelect;
export type Playlist = typeof playlists.$inferSelect;
export type Friendship = typeof friendships.$inferSelect;
export type User = typeof users.$inferSelect;
