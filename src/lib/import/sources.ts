// URL classification + Spotify/Apple Music metadata scrapers, ported from the
// desktop importer's core/spotify.py and core/apple_music.py. Both stores are
// DRM-locked, so they are metadata-only sources: each track is later matched
// to YouTube (lib/import/match.ts) and the audio comes from there.
//
// No SSRF surface: the user's URL is only ever parsed - ids are regex-extracted
// and interpolated into fixed-host templates (open.spotify.com,
// api-partner.spotify.com, music.apple.com, amp-api.music.apple.com,
// itunes.apple.com). Art URLs are fetched later through fetchCoverArt's guard.

export type SourceKind = "youtube" | "spotify" | "apple";

// A YouTube URL is the only user input passed verbatim to yt-dlp, whose
// generic extractor will fetch arbitrary hosts - so it gets a strict hostname
// allowlist, unlike the Spotify/Apple branches (id-extraction only, above).
const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
]);

/** One track's metadata, identical shape from every source. */
export type SourceTrack = {
  artist: string;
  title: string;
  album: string;
  artUrl: string;
  duration: number; // seconds; 0 when unknown
};

export function classifyUrl(url: string): SourceKind | null {
  if (
    url.includes("open.spotify.com") &&
    /(playlist|album|track)\/([A-Za-z0-9]+)/.test(url)
  ) {
    return "spotify";
  }
  if (url.includes("music.apple.com") && /\/(playlist|album|song)\//.test(url)) {
    return "apple";
  }
  try {
    if (YOUTUBE_HOSTS.has(new URL(url).hostname)) return "youtube";
  } catch {
    // not a parseable URL - fall through
  }
  return null;
}

const FETCH_TIMEOUT_MS = 30_000;
const UA = { "User-Agent": "Mozilla/5.0" };

async function get(url: string, headers?: Record<string, string>): Promise<string> {
  const res = await fetch(url, {
    headers: { ...UA, ...headers },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${new URL(url).hostname} returned ${res.status}`);
  return res.text();
}

/* eslint-disable @typescript-eslint/no-explicit-any -- scraped JSON is untyped */

// ---------------------------------------------------------------------------
// Spotify - via the public web player, no credentials. The documented Web API
// requires OAuth and 403s new apps, so we read what the embed page carries: an
// anonymous access token the web player's GraphQL ("pathfinder") API accepts,
// including offset pagination, so playlists of any length work.

const PATHFINDER_URL = "https://api-partner.spotify.com/pathfinder/v1/query";
const FETCH_PLAYLIST_HASH =
  "b39f62e9b566aa849b1780927de1450f47e02c54abf1e66e513f96e849591e41";

function largestImage(images: any[] | undefined, widthKey = "width"): string {
  let best: any = null;
  for (const im of images ?? []) {
    if (!best || (im[widthKey] ?? 0) > (best[widthKey] ?? 0)) best = im;
  }
  return best?.url ?? "";
}

async function spotifyEmbedState(
  itemId: string,
  kind: "playlist" | "album" | "track"
) {
  const html = await get(`https://open.spotify.com/embed/${kind}/${itemId}`);
  // [\s\S] instead of the `s` flag - tsconfig targets pre-es2018.
  const m = html.match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/
  );
  // A private/deleted/region-blocked item renders an embed page without the
  // expected state - surface that readably instead of a TypeError.
  const state = m ? JSON.parse(m[1])?.props?.pageProps?.state : undefined;
  if (!state?.data?.entity) {
    throw new Error(
      `couldn't read that Spotify ${kind} - is it public and the link correct?`
    );
  }
  return state;
}

async function pathfinderTracks(
  playlistId: string,
  token: string
): Promise<SourceTrack[]> {
  const tracks: SourceTrack[] = [];
  let offset = 0;
  let total: number | null = null;
  while (total === null || offset < total) {
    const params = new URLSearchParams({
      operationName: "fetchPlaylist",
      variables: JSON.stringify({
        uri: `spotify:playlist:${playlistId}`,
        offset,
        limit: 100,
      }),
      extensions: JSON.stringify({
        persistedQuery: { version: 1, sha256Hash: FETCH_PLAYLIST_HASH },
      }),
    });
    const body = JSON.parse(
      await get(`${PATHFINDER_URL}?${params}`, {
        Authorization: `Bearer ${token}`,
      })
    );
    // GraphQL errors come back 200 with no data - treat as a failure so the
    // caller falls back to the embed track list.
    const content = body?.data?.playlistV2?.content;
    if (!content) throw new Error("pathfinder returned no playlist data");
    total = content.totalCount;
    for (const item of content.items ?? []) {
      const data = item?.itemV2?.data;
      if (data?.__typename !== "Track" || !data.name) continue;
      const artists = (data.artists?.items ?? []).map(
        (a: any) => a.profile?.name ?? ""
      );
      tracks.push({
        artist: artists[0] ?? "",
        title: data.name,
        album: data.albumOfTrack?.name ?? "",
        artUrl: largestImage(data.albumOfTrack?.coverArt?.sources),
        duration: (data.trackDuration?.totalMilliseconds ?? 0) / 1000,
      });
    }
    offset += 100;
  }
  return tracks;
}

async function spotifyPlaylist(playlistId: string): Promise<SourceTrack[]> {
  const state = await spotifyEmbedState(playlistId, "playlist");
  try {
    const token = state.settings?.session?.accessToken;
    if (!token) throw new Error("embed page carried no access token");
    return await pathfinderTracks(playlistId, token);
  } catch {
    // Web-player API failed - fall back to the embed's own track list
    // (max 100 tracks, no album/art info).
    return (state.data.entity.trackList ?? []).map((t: any) => ({
      artist: t.subtitle ?? "",
      title: t.title,
      album: "",
      artUrl: "",
      duration: (t.duration ?? 0) / 1000,
    }));
  }
}

async function spotifyAlbum(albumId: string): Promise<SourceTrack[]> {
  // The album embed carries the full track list plus the album name and
  // cover, so no pathfinder call is needed (unlike playlists).
  const ent = (await spotifyEmbedState(albumId, "album")).data.entity;
  const album = ent.name ?? ent.title ?? "";
  const artUrl = largestImage(ent.visualIdentity?.image, "maxWidth");
  return (ent.trackList ?? []).map((t: any) => ({
    artist: t.subtitle ?? "",
    title: t.title,
    album,
    artUrl,
    duration: (t.duration ?? 0) / 1000,
  }));
}

async function spotifySingle(trackId: string): Promise<SourceTrack[]> {
  const ent = (await spotifyEmbedState(trackId, "track")).data.entity;
  const images: any[] = ent.visualIdentity?.image ?? [];
  return [
    {
      artist: ent.artists?.[0]?.name ?? "",
      title: ent.name ?? ent.title ?? "",
      album: "", // not exposed on the embed page for single tracks
      artUrl: largestImage(images, "maxWidth"),
      duration: (ent.duration ?? 0) / 1000,
    },
  ];
}

export async function spotifyTracks(url: string): Promise<SourceTrack[]> {
  const track = url.match(/track\/([A-Za-z0-9]+)/);
  if (track) return spotifySingle(track[1]);
  const album = url.match(/album\/([A-Za-z0-9]+)/);
  if (album) return spotifyAlbum(album[1]);
  const playlist = url.match(/playlist\/([A-Za-z0-9]+)/);
  if (!playlist) throw new Error("Unrecognized Spotify URL");
  return spotifyPlaylist(playlist[1]);
}

// ---------------------------------------------------------------------------
// Apple Music - keyless iTunes Lookup API for albums/songs; playlists (pl.*
// ids) are absent from that API, so they go through the amp-api the web player
// uses, authorized with a bearer JWT scraped from the player's JS bundle (it
// rotates roughly monthly, hence scraped per job, never cached).

/** (kind, storefront, id) from an Apple Music URL. A song is an album URL
 * carrying ?i= (the song's id) or a /song/ URL; storefront defaults to us. */
function appleParse(url: string): {
  kind: "playlist" | "album" | "song";
  storefront: string;
  id: string;
} {
  const storefront = url.match(/music\.apple\.com\/([a-z]{2})\//)?.[1] ?? "us";
  const song = url.match(/[?&]i=(\d+)/);
  if (song) return { kind: "song", storefront, id: song[1] };
  const playlist = url.match(/\/playlist\/[^/]*\/(pl\.[A-Za-z0-9]+)/);
  if (playlist) return { kind: "playlist", storefront, id: playlist[1] };
  const album = url.match(/\/album\/[^/]*\/(\d+)/);
  if (album) return { kind: "album", storefront, id: album[1] };
  const single = url.match(/\/song\/(\d+)/);
  if (single) return { kind: "song", storefront, id: single[1] };
  throw new Error("Unrecognized Apple Music URL");
}

/** Scrape the web player's anonymous bearer JWT - the JS bundle ships two;
 * the amp-api one is issued by "AMPWebPlay". */
async function appleToken(): Promise<string> {
  const html = await get("https://music.apple.com/us/browse");
  const bundle = html.match(/\/assets\/index~[^"']+\.js/);
  if (!bundle) throw new Error("could not locate the Apple Music player bundle");
  const js = await get(`https://music.apple.com${bundle[0]}`);
  for (const tok of js.match(
    /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g
  ) ?? []) {
    try {
      const payload = JSON.parse(
        Buffer.from(tok.split(".")[1], "base64url").toString()
      );
      if (payload.iss === "AMPWebPlay") return tok;
    } catch {
      continue;
    }
  }
  throw new Error("could not extract the Apple Music player token");
}

/** Concrete 1200px cover URL from an Apple artwork reference - either an
 * amp-api {w}x{h} template or an iTunes 100x100 thumbnail. */
function appleArtwork(url: string): string {
  return url
    .replace("{w}", "1200")
    .replace("{h}", "1200")
    .replace("100x100bb", "1200x1200bb");
}

async function applePlaylist(
  storefront: string,
  playlistId: string
): Promise<SourceTrack[]> {
  const headers = {
    Authorization: `Bearer ${await appleToken()}`,
    Origin: "https://music.apple.com",
  };
  const tracks: SourceTrack[] = [];
  // `next` is a path the API returns for the following page - appended to the
  // fixed amp-api origin, never fetched as a full URL.
  let path: string | undefined =
    `/v1/catalog/${storefront}/playlists/${playlistId}/tracks?limit=100&offset=0`;
  while (path) {
    const data = JSON.parse(
      await get(`https://amp-api.music.apple.com${path}`, headers)
    );
    for (const item of data.data ?? []) {
      const a = item.attributes;
      if (!a?.name) continue;
      tracks.push({
        artist: a.artistName ?? "",
        title: a.name,
        album: a.albumName ?? "",
        artUrl: appleArtwork(a.artwork?.url ?? ""),
        duration: (a.durationInMillis ?? 0) / 1000,
      });
    }
    path = data.next;
  }
  return tracks;
}

async function itunesTracks(id: string, entity?: string): Promise<SourceTrack[]> {
  const params = new URLSearchParams({ id });
  if (entity) {
    params.set("entity", entity);
    params.set("limit", "200");
  }
  const data = JSON.parse(await get(`https://itunes.apple.com/lookup?${params}`));
  return (data.results ?? [])
    .filter((r: any) => r.wrapperType === "track")
    .map((r: any) => ({
      artist: r.artistName ?? "",
      title: r.trackName ?? "",
      album: r.collectionName ?? "",
      artUrl: appleArtwork(r.artworkUrl100 ?? ""),
      duration: (r.trackTimeMillis ?? 0) / 1000,
    }));
}

export async function appleMusicTracks(url: string): Promise<SourceTrack[]> {
  const { kind, storefront, id } = appleParse(url);
  if (kind === "playlist") return applePlaylist(storefront, id);
  if (kind === "album") return itunesTracks(id, "song");
  return itunesTracks(id); // single song
}

/* eslint-enable @typescript-eslint/no-explicit-any */
