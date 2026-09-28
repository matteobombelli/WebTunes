import {
  S3Client,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Upload } from "@aws-sdk/lib-storage";
import type { Readable } from "stream";
import { log } from "@/lib/log";

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

/**
 * Delete objects one at a time in the given order, logging and skipping any
 * failure. Call only after the owning rows' deletion has committed: an orphaned
 * object is harmless, a row pointing at a deleted object is not.
 */
export async function deleteObjectsBestEffort(keys: string[]): Promise<void> {
  for (const key of keys) {
    try {
      await deleteObject(key);
    } catch (err) {
      log.warn(
        "s3",
        `Could not delete object ${key}`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }
}

/** Download an object's full bytes into a Buffer (server-side use only). */
export async function getObjectBytes(key: string): Promise<Buffer> {
  const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return Buffer.from(await obj.Body!.transformToByteArray());
}

const PRESIGN_TTL_SEC = 3600;
// Reuse a freshly-signed URL briefly to avoid repeated signing work when list
// views request the same object. The authenticated redirect routes cache their
// 302 for exactly this window, so a cached redirect (up to 300 s old, minted
// from a URL up to 300 s old) always points at a URL with >= 50 min left.
export const PRESIGN_REUSE_SEC = 300;
const PRESIGN_REUSE_MS = PRESIGN_REUSE_SEC * 1000;
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
    new GetObjectCommand({
      Bucket: BUCKET,
      Key: key,
      // Signed into the query so it can't be tampered with; without it the
      // browser falls back to heuristic freshness for the object response.
      ResponseCacheControl: "private, max-age=86400",
    }),
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

let originPromise: Promise<string> | null = null;

/**
 * Origin the presigned URLs point at, for a document-level preconnect. Derived
 * by signing a throwaway key (local HMAC, no network) rather than rebuilt from
 * S3_ENDPOINT, because whether the SDK uses path or virtual-host style depends
 * on the endpoint and bucket name. Bypasses the presign cache via a custom TTL.
 */
export function storageOrigin(): Promise<string> {
  if (!originPromise) {
    originPromise = getPresignedGetUrl("preconnect", 60).then(
      ({ url }) => new URL(url).origin,
      (err) => {
        originPromise = null; // don't memoize a transient credential failure
        throw err;
      }
    );
  }
  return originPromise;
}
