// Applies scripts/s3-cors.json to the production bucket so the browser can
// fetch presigned URLs for offline downloads. Repeatable; run after any
// change to s3-cors.json:
//   node scripts/apply-s3-cors.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GetBucketCorsCommand,
  PutBucketCorsCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const env = Object.fromEntries(
  readFileSync(join(root, ".env.production"), "utf8")
    .split("\n")
    .filter((line) => line.includes("=") && !line.startsWith("#"))
    .map((line) => {
      const i = line.indexOf("=");
      return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
    })
);

const bucket = env.S3_BUCKET;
const corsConfig = JSON.parse(readFileSync(join(root, "scripts/s3-cors.json"), "utf8"));

const client = new S3Client({
  region: env.S3_REGION,
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  },
});

await client.send(
  new PutBucketCorsCommand({ Bucket: bucket, CORSConfiguration: corsConfig })
);
const { CORSRules } = await client.send(new GetBucketCorsCommand({ Bucket: bucket }));
console.log(`CORS applied to ${bucket}:`);
console.log(JSON.stringify(CORSRules, null, 2));
