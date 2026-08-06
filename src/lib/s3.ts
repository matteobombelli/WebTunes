import {
  S3Client,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Upload } from "@aws-sdk/lib-storage";
import type { Readable } from "stream";

// Works against MinIO in dev and Cloudflare R2 in prod (both via S3_ENDPOINT)
// with no code change.
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

/** Download an object's full bytes into a Buffer (server-side use only). */
export async function getObjectBytes(key: string): Promise<Buffer> {
  const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return Buffer.from(await obj.Body!.transformToByteArray());
}

const PRESIGN_TTL_SEC = 3600;
// Reuse a freshly-signed URL briefly to avoid repeated signing work when list
// views request the same object. Authenticated redirect routes are no-store;
// callers that receive the URL directly can still benefit from target caching.
// The short window also ensures a reused URL retains at least 55 min validity.
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
      // A burst can fill the cache entirely with fresh entries, so expiry-only
      // cleanup is not enough to enforce the advertised bound. Map iteration
      // order gives us a cheap oldest-entry eviction for the remaining excess.
      while (presignCache.size >= PRESIGN_CACHE_CAP) {
        const oldestKey = presignCache.keys().next().value;
        if (oldestKey === undefined) break;
        presignCache.delete(oldestKey);
      }
    }
    presignCache.set(key, { url, signedAt: now });
  }
  return { url, expiresAt: new Date(now + expiresInSec * 1000) };
}
