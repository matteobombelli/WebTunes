// Applies scripts/s3-lifecycle.json to the production bucket so R2 aborts
// incomplete multipart uploads (left by a crashed/killed upload — they count
// toward storage and are invisible to a normal object listing). Repeatable; run
// after any change to s3-lifecycle.json:
//   node scripts/apply-s3-lifecycle.mjs
// S3_* creds come from the process environment when set, otherwise from the
// first env file present (.env.production locally, .env on the VPS).
// Like apply-s3-cors.mjs, this is a bucket-level call: Cloudflare R2 needs an
// Admin Read & Write token — the app's object-scoped token gets AccessDenied.
// Export admin S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY (plus S3_BUCKET etc.) first.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GetBucketLifecycleConfigurationCommand,
  ListMultipartUploadsCommand,
  PutBucketLifecycleConfigurationCommand,
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
const lifecycleConfig = JSON.parse(
  readFileSync(join(root, "scripts/s3-lifecycle.json"), "utf8")
);

// Client construction must mirror src/lib/s3.ts exactly (see apply-s3-cors.mjs).
const client = new S3Client({
  region: env.S3_REGION,
  endpoint: env.S3_ENDPOINT || undefined,
  forcePathStyle: env.S3_FORCE_PATH_STYLE === "true",
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  },
});

console.log(
  `bucket=${bucket} region=${env.S3_REGION} endpoint=${env.S3_ENDPOINT || "(default AWS)"}`
);

// Show what the rule will clean up. ListMultipartUploads is the only way to see
// these — they never appear in ListObjectsV2.
try {
  const { Uploads = [] } = await client.send(
    new ListMultipartUploadsCommand({ Bucket: bucket })
  );
  console.log(`Incomplete multipart uploads currently present: ${Uploads.length}`);
  for (const u of Uploads) {
    console.log(`  ${u.Key} — initiated ${u.Initiated?.toISOString?.() ?? u.Initiated}`);
  }
} catch (err) {
  console.log(`(could not list incomplete uploads: ${err.message})`);
}

await client.send(
  new PutBucketLifecycleConfigurationCommand({
    Bucket: bucket,
    LifecycleConfiguration: lifecycleConfig,
  })
);
const { Rules } = await client.send(
  new GetBucketLifecycleConfigurationCommand({ Bucket: bucket })
);
console.log(`Lifecycle applied to ${bucket}:`);
console.log(JSON.stringify(Rules, null, 2));
