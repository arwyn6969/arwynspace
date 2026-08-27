/**
 * Media probing and rendition selection.
 *
 * Metadata for these assets often ships several renditions of the same artwork
 * (thumb / display / hi-res). We probe each cheaply, keep the real dimensions,
 * and let the caller display the best one. The scaling decision is then made
 * from the rendition actually shown — which matters because a 48x48 thumbnail
 * of a 4000x5600 painting must NOT be nearest-neighbour scaled, while a 28x37
 * stamp must be.
 */

import crypto from "node:crypto";
import { sniffMime, readDimensions, mimeFromUrl, normalizeArweave, preferHttps, isImage, isVideo, isAudio, gifFrameCount, isAnimatedWebp, isAnimatedPng } from "./resolve.mjs";

// arweave.net is the only gateway consistently up; permagate kept as a long shot.
const ARWEAVE_GATEWAYS = ["https://arweave.net", "https://permagate.io"];

/**
 * Known non-artwork placeholder images, fingerprinted by md5 of their first 4KB.
 * cdn.xcp.io serves the Counterparty logo for assets it has no art for, and
 * accepting those would silently fill the gallery with fake hits.
 */
const PLACEHOLDER_FINGERPRINTS = new Set([
  "90c76b7dee2a44aa33e32352fd932fff", // Counterparty logo, 300x180 PNG (cdn.xcp.io "no art")
]);

export function fingerprint(buf) {
  return crypto.createHash("md5").update(buf.slice(0, 4096)).digest("hex");
}

export function isPlaceholder(buf) {
  return PLACEHOLDER_FINGERPRINTS.has(fingerprint(buf));
}

/**
 * xcp.io mirrors artwork for Counterparty assets, which recovers pieces whose
 * original metadata host has died. CORS is open and caching is immutable, so
 * these URLs are safe to embed directly.
 *   /img/full/{ASSET} — original file (can be tens of MB, and may be video)
 *   /img/icon/{ASSET} — small thumbnail
 */
export const xcpIoUrl = (asset, size = "full") => `https://cdn.xcp.io/img/${size}/${encodeURIComponent(asset)}`;

/** Rewrite an Arweave URL onto an alternate gateway (for retry). */
function onGateway(url, gateway) {
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith("arweave.net")) return url;
    return gateway + u.pathname;
  } catch { return url; }
}

async function fetchWithTimeout(url, opts = {}, ms = 30000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { ...opts, signal: c.signal, redirect: "follow" }); }
  finally { clearTimeout(t); }
}

/**
 * Probe a media URL: confirm it resolves, determine its real mime type and
 * pixel dimensions. Reads only the leading bytes — enough for every header
 * format we care about — so probing a 2.5MB PNG costs a few KB.
 */
export async function probeMedia(rawUrl, { headBytes = 16384, timeout = 15000 } = {}) {
  const url = preferHttps(normalizeArweave(rawUrl));
  let attempts = [url];
  try {
    if (new URL(url).hostname.endsWith("arweave.net")) {
      for (const g of ARWEAVE_GATEWAYS.slice(1)) attempts.push(onGateway(url, g));
    }
  } catch { return { ok: false, url: rawUrl, reason: "bad_url" }; }

  for (const attempt of attempts) {
    try {
      const r = await fetchWithTimeout(attempt, { headers: { Range: `bytes=0-${headBytes - 1}` } }, timeout);
      if (!r.ok && r.status !== 206) continue;

      const headerMime = (r.headers.get("content-type") || "").split(";")[0].trim() || null;
      const buf = Buffer.from(await r.arrayBuffer());
      if (!buf.length) continue;

      if (isPlaceholder(buf)) return { ok: false, url: attempt, reason: "placeholder_image" };

      const sniffed = sniffMime(buf);
      // Trust sniffed bytes over a server header (Arweave sometimes says text/html for images).
      const mime = sniffed || (headerMime && headerMime !== "text/html" ? headerMime : null) || mimeFromUrl(attempt);
      if (!mime) continue;
      // An HTML body when we expected media means we landed on an error page.
      if (mime === "text/html" && !/\.html?$/i.test(new URL(attempt).pathname)) continue;

      const dims = readDimensions(buf, mime);
      const total = Number((r.headers.get("content-range") || "").split("/")[1]) || Number(r.headers.get("content-length")) || null;

      return { ok: true, url: attempt, mime, dims, bytes: total, kind: isVideo(mime) ? "video" : isAudio(mime) ? "audio" : isImage(mime) ? "image" : "other" };
    } catch { /* try next gateway */ }
  }
  return { ok: false, url, reason: "unreachable" };
}

/**
 * Last-resort artwork lookup via xcp.io's mirror. Returns both the full file
 * and its thumbnail, rejecting the placeholder logo.
 */
export async function probeXcpIo(asset) {
  const full = await probeMedia(xcpIoUrl(asset, "full"), { timeout: 20000 });
  if (!full.ok) return null;
  const icon = await probeMedia(xcpIoUrl(asset, "icon"), { timeout: 15000 });
  return { full, icon: icon?.ok ? icon : null };
}

/** Fetch and parse a JSON metadata document, retrying across Arweave gateways. */
export async function fetchJson(rawUrl, { timeout = 30000, retries = 3 } = {}) {
  const url = preferHttps(normalizeArweave(rawUrl));
  const attempts = [url];
  try {
    if (new URL(url).hostname.endsWith("arweave.net")) {
      for (const g of ARWEAVE_GATEWAYS.slice(1)) attempts.push(onGateway(url, g));
    }
  } catch { return { ok: false, reason: "bad_url", url }; }

  for (let round = 0; round < retries; round++) {
    for (const attempt of attempts) {
      try {
        const r = await fetchWithTimeout(attempt, {}, timeout);
        if (!r.ok) continue;
        const text = await r.text();
        if (!text.trim()) continue;               // dead host returning 200 + empty body
        try { return { ok: true, url: attempt, json: JSON.parse(text) }; }
        catch { if (/^\s*</.test(text)) continue; return { ok: false, reason: "not_json", url: attempt }; }
      } catch { /* next */ }
    }
    if (round < retries - 1) await new Promise(r => setTimeout(r, 1200 * (round + 1)));
  }
  return { ok: false, reason: "unreachable_or_empty", url };
}

const maxDim = r => Math.max(r?.dims?.w ?? 0, r?.dims?.h ?? 0);

/**
 * Pick renditions for each context from measured pixel dimensions.
 *
 * Dimensions come straight from the file header and are always trustworthy;
 * byte counts are not, because gateways redirect and drop content-length on
 * ranged requests. So size selection is driven purely by dimensions:
 *
 *   thumb    — smallest rendition still sharp on a ~260px grid card
 *   display  — smallest rendition still sharp on a large detail stage
 *   original — the biggest available, offered as "view original"
 *
 * Choosing the smallest sufficient rendition matters: some originals here are
 * 4000x5600 / 2.5MB, which would make a grid of them unusable.
 */
export const MIN_THUMB_DIM = 400;

export function chooseRenditions(renditions, { thumbTarget = MIN_THUMB_DIM, displayTarget = 1400 } = {}) {
  const ok = renditions.filter(r => r?.ok && r.kind === "image");
  if (!ok.length) return { thumb: null, display: null, original: null, all: [] };

  const asc = [...ok].sort((a, b) => maxDim(a) - maxDim(b));
  const original = asc[asc.length - 1];

  // Smallest rendition at or above each target; fall back to the largest we have.
  const atLeast = px => asc.find(r => maxDim(r) >= px) ?? original;

  const display = atLeast(displayTarget);

  // A thumbnail is only useful if it is actually large enough for a grid card.
  // Returning an undersized one causes the grid to upscale a tiny file, which is
  // exactly how 48px icons ended up being displayed as artwork.
  const thumbCand = atLeast(thumbTarget);
  const thumb = maxDim(thumbCand) >= thumbTarget ? thumbCand : null;

  return {
    thumb,
    display,
    original: original !== display ? original : null,
    all: asc,
  };
}


/**
 * Determine whether a remote image actually animates.
 *
 * Needed because Kaleidoscope's WebP renditions strip animation, so an animated
 * GIF must be served as its original file to move at all — and pulling a 10MB
 * original for a still would be wasteful.
 *
 * Frames can sit far apart in a large GIF, so a fixed small read can't always
 * decide. The result is therefore three-valued: when only one frame is visible
 * but the file was truncated, the answer is "unknown" and callers should serve
 * the original anyway. Being wrong about a still costs bandwidth; being wrong
 * about an animation costs the artwork.
 */
export async function probeAnimation(rawUrl, { window = 1_048_576, timeout = 45000 } = {}) {
  const url = preferHttps(normalizeArweave(rawUrl));
  try {
    const r = await fetchWithTimeout(url, { headers: { Range: `bytes=0-${window - 1}` } }, timeout);
    if (!r.ok && r.status !== 206) return { animated: null, reason: "unreachable" };

    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length) return { animated: null, reason: "empty" };

    const total = Number((r.headers.get("content-range") || "").split("/")[1]) || null;
    const truncated = total != null ? buf.length < total : buf.length >= window;
    const mime = sniffMime(buf) || mimeFromUrl(url);

    if (mime === "image/gif") {
      const g = gifFrameCount(buf);
      if (!g) return { animated: null, reason: "unparseable", mime };
      if (g.animated) return { animated: true, frames: g.frames, mime, bytes: total };
      // One frame found, but we may simply not have reached the second.
      if (truncated) return { animated: null, reason: "truncated", frames: g.frames, mime, bytes: total };
      return { animated: false, frames: g.frames, mime, bytes: total };
    }
    if (mime === "image/webp") return { animated: isAnimatedWebp(buf), mime, bytes: total };
    if (mime === "image/png")  return { animated: isAnimatedPng(buf), mime, bytes: total };
    return { animated: false, mime, bytes: total };
  } catch (e) {
    return { animated: null, reason: String(e.message || e) };
  }
}
