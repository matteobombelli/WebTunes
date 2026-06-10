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

/** Presigned GET URL; S3/MinIO serve Range requests, so seeking works. */
export async function getPresignedGetUrl(key: string, expiresInSec = 3600) {
  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: BUCKET, Key: key }),
    { expiresIn: expiresInSec }
  );
  return { url, expiresAt: new Date(Date.now() + expiresInSec * 1000) };
}
