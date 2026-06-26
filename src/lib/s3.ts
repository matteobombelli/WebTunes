import {
  S3Client,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Upload } from "@aws-sdk/lib-storage";
import type { Readable } from "stream";

// Works against MinIO in dev (S3_ENDPOINT + path-style) and AWS S3 in prod
// (S3_ENDPOINT unset) with no code change.
const s3 = new S3Client({
  region: process.env.S3_REGION,
  endpoint: process.env.S3_ENDPOINT || undefined,
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID!,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
  },
});

const BUCKET = process.env.S3_BUCKET!;

export async function uploadObject(
  key: string,
  body: Buffer | Readable,
  contentType?: string
) {
  await new Upload({
    client: s3,
    params: { Bucket: BUCKET, Key: key, Body: body, ContentType: contentType },
  }).done();
}

export async function deleteObject(key: string) {
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

const PRESIGN_TTL_SEC = 3600;
// Reuse a freshly-signed URL for up to this long so repeat list loads (e.g. the
// Playlists grid's covers) return the *same* URL and the browser serves the
// image from cache instead of re-fetching a newly-signed one each navigation.
// Kept short so a reused URL always has ≥55 min of validity left — safely above
// the 50-min Cache-Control on the /art and /stream redirects, so a browser that
// cached one of those redirects can never outlive its target.
const PRESIGN_REUSE_MS = 5 * 60 * 1000;
const PRESIGN_CACHE_CAP = 2000;
const presignCache = new Map<string, { url: string; signedAt: number }>();

/** Presigned GET URL; S3/MinIO serve Range requests, so seeking works. */
export async function getPresignedGetUrl(
  key: string,
  expiresInSec = PRESIGN_TTL_SEC
) {
  const now = Date.now();
  // Only the default-TTL signing path is cached; custom expiries bypass it.
  if (expiresInSec === PRESIGN_TTL_SEC) {
    const hit = presignCache.get(key);
    if (hit && now - hit.signedAt < PRESIGN_REUSE_MS) {
      return {
        url: hit.url,
        expiresAt: new Date(hit.signedAt + expiresInSec * 1000),
      };
    }
  }
  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: BUCKET, Key: key }),
    { expiresIn: expiresInSec }
  );
  if (expiresInSec === PRESIGN_TTL_SEC) {
    if (presignCache.size >= PRESIGN_CACHE_CAP) {
      for (const [k, v] of presignCache) {
        if (now - v.signedAt >= PRESIGN_REUSE_MS) presignCache.delete(k);
      }
    }
    presignCache.set(key, { url, signedAt: now });
  }
  return { url, expiresAt: new Date(now + expiresInSec * 1000) };
}
