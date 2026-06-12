// Applies scripts/s3-cors.json to the production bucket so the browser can
// fetch presigned URLs for offline downloads. Repeatable; run after any
// change to s3-cors.json:
//   node scripts/apply-s3-cors.mjs
// S3_* creds come from the process environment when set, otherwise from the
// first env file present (.env.production locally, .env on the VPS).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GetBucketCorsCommand,
  PutBucketCorsCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const ENV_FILES = [".env.production", ".env", ".env.local"];

function loadEnv() {
  if (process.env.S3_BUCKET) return process.env;
  const file = ENV_FILES.map((f) => join(root, f)).find(existsSync);
  if (!file) {
    console.error(
      `No S3_BUCKET in the environment and none of ${ENV_FILES.join(", ")} exist in ${root}`
    );
    process.exit(1);
  }
  return Object.fromEntries(
    readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.includes("=") && !line.startsWith("#"))
      .map((line) => {
        const i = line.indexOf("=");
        return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
      })
  );
}

const env = loadEnv();

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
