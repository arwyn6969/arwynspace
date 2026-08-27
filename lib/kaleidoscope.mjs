/**
 * Kaleidoscope media registry — the highest-quality artwork source available.
 *
 * https://kaleidoscopexcp.net/api/media returns the whole catalogue in one
 * ~2.2MB response (query params are accepted but ignored), so it is fetched once
 * and cached to disk.
 *
 * Why it takes priority over everything else:
 *  - Three ready-made renditions per piece (thumb / web / original), so there is
 *    no need to probe files or guess which URL is the real artwork.
 *  - Exact width and height are supplied, which removes nearly all network work
 *    from indexing and makes the pixel-art scaling decision reliable.
 *  - Real titles, descriptions, artist names and tags, replacing bare asset codes.
 *  - Video carries a poster frame and a duration.
 *  - An IPFS CID per piece, as a permanent fallback if the host disappears.
 *
 * It serves no CORS headers, so it must be read server-side — which is where
 * indexing happens anyway.
 */

import fs from "node:fs";
import path from "node:path";

const API = "https://kaleidoscopexcp.net/api/media";
export const MEDIA_HOST = "https://kaleidoscopexcp.net";

const abs = p => (typeof p === "string" && p.startsWith("/") ? MEDIA_HOST + p : p || null);

/**
 * Fetch the registry, falling back to the on-disk cache when the host is
 * unreachable so an outage can't wipe artwork out of the index.
 */
export async function fetchRegistry({ cacheFile, maxAgeHours = 12, timeout = 90000 } = {}) {
  if (cacheFile && fs.existsSync(cacheFile)) {
    const ageH = (Date.now() - fs.statSync(cacheFile).mtimeMs) / 3.6e6;
    if (ageH < maxAgeHours) {
      const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
      return { items: cached.items ?? cached, fromCache: true, ageHours: ageH };
    }
  }

  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), timeout);
    const r = await fetch(API, { signal: c.signal, headers: { Accept: "application/json" } });
    clearTimeout(t);
    if (!r.ok) throw new Error("http " + r.status);
    const json = await r.json();
    const items = json.items ?? [];
    if (cacheFile && items.length) {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify({ fetchedAt: new Date().toISOString(), total: json.total, items }));
    }
    return { items, fromCache: false, total: json.total };
  } catch (e) {
    if (cacheFile && fs.existsSync(cacheFile)) {
      const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
      return { items: cached.items ?? cached, fromCache: true, stale: true, error: String(e.message) };
    }
    throw e;
  }
}

/**
 * Index the registry by asset name for lookup.
 *
 * Keys are uppercased because Kaleidoscope stores names in mixed case
 * ("satanshi" alongside "CYPHERPOOHNK") while Counterparty is uppercase.
 * Both the plain name and any subasset longname are indexed, since Counterparty
 * hands back numeric IDs for subassets and only the longname will match.
 */
export function indexByAsset(items) {
  const map = new Map();
  for (const it of items) {
    const name = (it.assetName || "").trim();
    if (!name) continue;
    const key = name.toUpperCase();
    // Prefer the entry with real media if a name somehow repeats.
    const existing = map.get(key);
    if (!existing || (!existing.originalPath && it.originalPath)) map.set(key, it);
  }
  return map;
}

/** Look an asset up by plain name, then by subasset longname. */
export function lookup(map, asset, longname) {
  if (!map) return null;
  return map.get(String(asset || "").toUpperCase())
      ?? (longname ? map.get(String(longname).toUpperCase()) : null)
      ?? null;
}

const EXT_MIME = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", svg: "image/svg+xml", avif: "image/avif",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
  mp3: "audio/mpeg", wav: "audio/wav",
};

/**
 * Normalize a registry entry into the shape the indexer stores.
 *
 * Display uses the `web` rendition and the true original is offered on click:
 * originals here run to 10MB+, and a grid of them would be unusable, but the
 * full-fidelity file stays one click away.
 */
export function normalizeEntry(it) {
  if (!it) return null;

  const fmt = String(it.format || "").toLowerCase();
  const originalMime = EXT_MIME[fmt] ?? null;
  const isVideo = it.type === "video" || (originalMime || "").startsWith("video/");

  const thumb    = abs(it.thumbPath);
  const web      = abs(it.webPath);
  const original = abs(it.originalPath);
  const poster   = abs(it.posterPath);

  // Registry dimensions describe the ORIGINAL, which is what the scaling
  // decision must be based on — never the downscaled rendition being shown.
  const dims = (it.width && it.height) ? { w: Number(it.width), h: Number(it.height) } : null;

  return {
    kaleidoscopeId: it.kaleidoscopeId ?? null,
    title: (it.name || "").trim() || null,
    text: (it.description || "").trim() || null,
    artist: (it.artistName || "").trim() || null,
    tags: Array.isArray(it.tags) ? it.tags.filter(Boolean) : [],
    ownerAddress: it.ownerAddress || null,

    // The web rendition serves BOTH grid and detail. Kaleidoscope's thumb tier
    // measures around 278x384, below the 400px floor a grid card needs, so using
    // it would reintroduce upscaled-thumbnail blur. The web tier is only ~62KB,
    // small enough to populate a grid comfortably.
    image: isVideo ? (poster || web || thumb) : (web || original || thumb),
    imageMime: isVideo ? "image/webp" : (web ? "image/webp" : originalMime),
    thumb: null,
    original,
    originalMime,
    originalDims: dims,
    dims,

    animationUrl: isVideo ? original : null,
    animationMime: isVideo ? originalMime : null,
    posterUrl: poster,
    durationSeconds: it.durationSeconds ?? null,

    ipfsCid: it.ipfsCid || null,
    fileSizeBytes: it.fileSizeBytes ?? null,
    hidden: !!it.hideFromWebsite || it.visibility === "private",
  };
}
