// Seeds two pre-friended demo accounts with royalty-free music.
// Idempotent: users are upserted by email, tracks by s3_key, the friendship
// by pair. Needs DATABASE_URL + S3_* env (reads .env.local when present) and
// internet access to download the tracks.
//
// Music: Kevin MacLeod (incompetech.com), licensed under CC BY 4.0.
// Album names are demo groupings, not official releases.

import bcrypt from "bcryptjs";
import pg from "pg";
import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { parseBuffer } from "music-metadata";

try {
  process.loadEnvFile(".env.local");
} catch {
  // env comes from the environment itself
}

const MP3_BASE = "https://incompetech.com/music/royalty-free/mp3-royaltyfree";
const ARTIST = "Kevin MacLeod";

const ACCOUNTS = [
  {
    name: "Demo1",
    email: "demo1@demo.demo",
    password: "Demo1",
    tracks: [
      { title: "Monkeys Spinning Monkeys", album: "Comedic Capers" },
      { title: "Sneaky Snitch", album: "Comedic Capers" },
      { title: "Fluffing a Duck", album: "Comedic Capers" },
      { title: "Carefree", album: "Sunny Days" },
      { title: "Wallpaper", album: "Sunny Days" },
      { title: "The Builder", album: "Sunny Days" },
      { title: "Itty Bitty 8 Bit", album: "Chiptune Adventures" },
      { title: "Local Forecast", album: "Lounge Sessions" },
      { title: "Local Forecast - Elevator", album: "Lounge Sessions", isPrivate: true },
      { title: "Lobby Time", album: "Lounge Sessions" },
    ],
  },
  {
    name: "Demo2",
    email: "demo2@demo.demo",
    password: "Demo2",
    tracks: [
      { title: "Impact Moderato", album: "Cinematic Moods" },
      { title: "Easy Lemon", album: "Cinematic Moods" },
      { title: "Heartbreaking", album: "Cinematic Moods" },
      { title: "Spirit of the Girl", album: "Cinematic Moods" },
      { title: "Meditation Impromptu 01", album: "Quiet Hours" },
      { title: "Deliberate Thought", album: "Quiet Hours" },
      { title: "Inspired", album: "Quiet Hours" },
      { title: "Bossa Antigua", album: "Smoky Bars" },
      { title: "Hidden Agenda", album: "Smoky Bars", isPrivate: true },
      { title: "George Street Shuffle", album: "Smoky Bars" },
    ],
  },
];

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const s3 = new S3Client({
  region: process.env.S3_REGION,
  endpoint: process.env.S3_ENDPOINT || undefined,
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },
});
const BUCKET = process.env.S3_BUCKET;

function slugify(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function upsertUser({ name, email, password }) {
  const passwordHash = await bcrypt.hash(password, 12);
  const { rows } = await pool.query(
    `insert into users (name, email, password_hash)
     values ($1, $2, $3)
     on conflict (email) do update set name = excluded.name,
       password_hash = excluded.password_hash
     returning id`,
    [name, email, passwordHash]
  );
  return rows[0].id;
}

async function objectExists(key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

async function seedTrack(userId, track, createdAt) {
  const s3Key = `audio/${userId}/seed-${slugify(track.title)}.mp3`;

  let durationSec = null;
  let fileSize = null;
  if (await objectExists(s3Key)) {
    console.log(`  = ${track.title} (audio already in S3)`);
  } else {
    const url = `${MP3_BASE}/${encodeURIComponent(track.title)}.mp3`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: s3Key,
        Body: buffer,
        ContentType: "audio/mpeg",
      })
    );
    fileSize = buffer.length;
    try {
      const meta = await parseBuffer(buffer, { mimeType: "audio/mpeg" });
      durationSec = meta.format.duration ? Math.round(meta.format.duration) : null;
    } catch {
      // duration stays null
    }
    console.log(`  + ${track.title} (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);
  }

  await pool.query(
    `insert into tracks (owner_id, title, artist, album, duration_sec, s3_key,
       mime_type, file_size, is_private, created_at)
     values ($1, $2, $3, $4, $5, $6, 'audio/mpeg', $7, $8, $9)
     on conflict (s3_key) do update set title = excluded.title,
       artist = excluded.artist, album = excluded.album,
       is_private = excluded.is_private,
       duration_sec = coalesce(excluded.duration_sec, tracks.duration_sec),
       file_size = coalesce(excluded.file_size, tracks.file_size)`,
    [
      userId,
      track.title,
      ARTIST,
      track.album,
      durationSec,
      s3Key,
      fileSize,
      track.isPrivate ?? false,
      createdAt,
    ]
  );
}

async function befriend(userIdA, userIdB) {
  const { rows } = await pool.query(
    `select id from friendships
     where (requester_id = $1 and addressee_id = $2)
        or (requester_id = $2 and addressee_id = $1)`,
    [userIdA, userIdB]
  );
  if (rows.length > 0) {
    await pool.query(
      `update friendships set status = 'accepted',
         responded_at = coalesce(responded_at, now())
       where id = $1`,
      [rows[0].id]
    );
  } else {
    await pool.query(
      `insert into friendships (requester_id, addressee_id, status, responded_at)
       values ($1, $2, 'accepted', now())`,
      [userIdA, userIdB]
    );
  }
}

const ids = [];
for (const account of ACCOUNTS) {
  console.log(`${account.name} <${account.email}>`);
  const userId = await upsertUser(account);
  ids.push(userId);
  for (const [i, track] of account.tracks.entries()) {
    // Stagger createdAt so "recently added" ordering looks natural.
    const createdAt = new Date(Date.now() - (i + 1) * 36e5 * 26);
    await seedTrack(userId, track, createdAt);
  }
}
await befriend(ids[0], ids[1]);
console.log("Friendship: Demo1 <-> Demo2 (accepted)");

await pool.end();
console.log("Done.");
