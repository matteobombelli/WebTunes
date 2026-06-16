// Single source of truth for the image types WebTunes accepts in uploads
// (track cover art — embedded on upload or set explicitly — and playlist
// covers). The browser-supplied MIME type and the filename extension are both
// attacker-controlled, so neither the stored S3 Content-Type nor the object
// key's extension is ever echoed back from them: a crafted upload could
// otherwise have e.g. text/html served from the object — and the offline
// service worker replays that Content-Type from a *same-origin* cache, turning
// it into stored XSS. Everything is resolved through this allowlist instead.

export type ImageKind = { ext: string; contentType: string };

const JPEG: ImageKind = { ext: "jpg", contentType: "image/jpeg" };
const PNG: ImageKind = { ext: "png", contentType: "image/png" };
const WEBP: ImageKind = { ext: "webp", contentType: "image/webp" };
const GIF: ImageKind = { ext: "gif", contentType: "image/gif" };

const BY_MIME: Record<string, ImageKind> = {
  "image/jpeg": JPEG,
  "image/png": PNG,
  "image/webp": WEBP,
  "image/gif": GIF,
};

const BY_EXT: Record<string, ImageKind> = {
  jpg: JPEG,
  jpeg: JPEG,
  png: PNG,
  webp: WEBP,
  gif: GIF,
};

/** Extensions accepted from an uploaded filename. */
export const IMAGE_EXTENSIONS = new Set(Object.keys(BY_EXT));

/**
 * Kind for embedded cover art, where only the tag's MIME is known. Falls back
 * to JPEG, the overwhelmingly common case for embedded art.
 */
export function imageKindFromMime(mime: string | null): ImageKind {
  return BY_MIME[mime ?? ""] ?? JPEG;
}

/**
 * Kind for an explicitly uploaded image file. Prefers the filename extension,
 * then the browser MIME; if neither is a recognized image, stores it under a
 * neutral key with a non-renderable binary Content-Type so it can never be
 * served as active content.
 */
export function imageKindFromUpload(ext: string, mime: string | null): ImageKind {
  return (
    BY_EXT[ext] ??
    BY_MIME[mime ?? ""] ?? { ext: "img", contentType: "application/octet-stream" }
  );
}
