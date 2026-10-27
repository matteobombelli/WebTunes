// Single source of truth for the deployment subpath. The app is served from the root of
// webtunes.matteob.dev, so this is empty; set it (e.g. "/projects/webtunes") to serve the app
// under a prefix again. Imported by next.config.ts (build) and the client fetch wrapper
// (runtime); public/sw.js carries a manual copy.
export const BASE_PATH = "";
