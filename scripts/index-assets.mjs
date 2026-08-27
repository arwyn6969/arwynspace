/**
 * Indexer: walks every configured wallet, resolves each issued asset to a
 * displayable artwork record, and writes data/artworks.json.
 *
 * Run:  node scripts/index-assets.mjs [--limit N] [--only ASSET] [--skip-probe]
 *
 * This is deliberately a build/refresh step rather than request-time work:
 * each asset costs 1-5 network calls across hosts that are slow, rate limited
 * or partly dead, so resolving live per pageview would be unusably slow.
 */

import fs from "node:fs";
import path from "node:path";
import { xcp, xcpAll } from "../lib/xcpfetch.mjs";
import {
  classifyDescription, KIND, interpretMetadata, shouldPixelate,
  normalizeArweave, htmlToText, mimeFromUrl, gifFrameCount,
} from "../lib/resolve.mjs";
import { probeMedia, fetchJson, chooseRenditions, probeXcpIo, xcpIoUrl, MIN_THUMB_DIM, probeAnimation } from "../lib/media.mjs";
import { allIssuances, collapseIssuances, addressInfo } from "../lib/tokenscan.mjs";
import { effectiveSupply, rarityOf, fmtEffective } from "../lib/units.mjs";
import { fetchRegistry, indexByAsset, lookup as kaleidoLookup, normalizeEntry } from "../lib/kaleidoscope.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const STAMPCHAIN = "https://stampchain.io/api/v2";

const args = process.argv.slice(2);
const flag = (n, d = null) => { const i = args.indexOf(n); return i === -1 ? d : (args[i + 1] ?? true); };
const LIMIT      = Number(flag("--limit", 0)) || 0;
const ONLY       = flag("--only", null);
const SKIP_PROBE = args.includes("--skip-probe");
// --offline: skip asking Counterparty for the asset list and reuse the cached
// snapshot. Useful when the public node is down, and for fast re-runs after
// editing overrides.
const OFFLINE    = args.includes("--offline");

const cfg       = JSON.parse(fs.readFileSync(path.join(ROOT, "config/wallets.json"), "utf8"));
const overrides = readJsonSafe(path.join(ROOT, "config/overrides.json")) ?? {};

function readJsonSafe(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------------- stampchain ---------------- */

async function sc(pathname, { timeout = 25000, retries = 3 } = {}) {
  for (let i = 0; i < retries; i++) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), timeout);
    try {
      const r = await fetch(STAMPCHAIN + pathname, { signal: c.signal });
      clearTimeout(t);
      if (r.status === 404) return { notFound: true };
      if (r.status === 429) { await sleep(4000 * (i + 1)); continue; }
      if (!r.ok) throw new Error("http " + r.status);
      return await r.json();
    } catch (e) { clearTimeout(t); if (i === retries - 1) return { error: String(e.message || e) }; await sleep(1200 * (i + 1)); }
  }
  return { error: "exhausted" };
}

/** Is this asset a Bitcoin Stamp? Stampchain 404s for pure Counterparty assets. */
async function lookupStamp(cpid) {
  const d = await sc(`/stamps/${encodeURIComponent(cpid)}`);
  if (!d || d.notFound || d.error) return null;
  const s = d?.data?.stamp ?? d?.data ?? null;
  return s && (s.stamp !== undefined || s.cpid) ? s : null;
}

/* ---------------- per-asset resolution ---------------- */

async function resolveAsset(a, ownerSet, kaleido) {
  const cls = classifyDescription(a.description);

  const rec = {
    asset: a.asset,
    assetLongname: a.asset_longname ?? null,
    title: null,
    issuer: a.issuer,
    owner: a.owner,
    // Which of the artist's wallets issued this. Several wallets have issuance
    // history but no current holdings — work made there and later moved.
    issuedFrom: a._sourceAddress ?? null,
    // tokenscan reports supply in HUMAN units. Both representations are stored
    // explicitly so nothing downstream has to guess or rescale.
    supply: a.supply,
    supplyUnits: Number(a.supply ?? 0) || 0,
    supplyAtomic: null,
    effectiveSupply: null,
    rarity: null,
    divisible: !!a.divisible,
    locked: !!a.locked,
    descriptionRaw: a.description ?? null,
    descriptionKind: cls.kind,
    text: null,
    descriptionHtml: null,
    website: null,
    attributes: [],
    isStamp: false,
    stampNumber: null,
    stampMimetype: null,
    media: { image: null, imageMime: null, dims: null, thumb: null, thumbDims: null, original: null, originalMime: null, originalDims: null, animationUrl: null, animationMime: null, posterUrl: null, audioUrl: null, audioMime: null, htmlUrl: null, dataUri: null },
    tags: [],
    animated: null,
    animatedUrl: null,
    firstBlock: a.first_issuance_block_index ?? null,
    lastBlock: a.last_issuance_block_index ?? null,
    ipfsCid: null,
    kaleidoscopeId: null,
    durationSeconds: null,
    pixelate: false,
    excluded: false,
    excludedReason: null,
    tokenOp: null,
    artist: null,
    note: null,
    sources: [],
    warnings: [],
  };

  // Numeric A-prefix assets are unnamed Counterparty assets (typical of stamps).
  rec.numeric = /^A\d+$/.test(a.asset);

  /* --- token operations are not artwork --- */
  if (cls.kind === KIND.SRC20_OP) {
    rec.excluded = true;
    rec.excludedReason = "src20_token_operation";
    rec.tokenOp = { protocol: "SRC-20", op: cls.op, tick: cls.tick, amt: cls.amt };
    return rec;
  }

  /* --- Kaleidoscope first: the best renditions, with dimensions already known --- */
  const kEntry = normalizeEntry(kaleidoLookup(kaleido, a.asset, a.asset_longname));
  if (kEntry && !kEntry.hidden) {
    rec.media.image        = kEntry.image;
    rec.media.imageMime    = kEntry.imageMime;
    rec.media.dims         = kEntry.dims;
    rec.media.thumb        = kEntry.thumb;
    rec.media.original     = kEntry.original;
    rec.media.originalMime = kEntry.originalMime;
    rec.media.originalDims = kEntry.originalDims;
    if (kEntry.animationUrl) {
      rec.media.animationUrl  = kEntry.animationUrl;
      rec.media.animationMime = kEntry.animationMime;
      rec.media.posterUrl     = kEntry.posterUrl;
      rec.durationSeconds     = kEntry.durationSeconds;
    }
    // The longname is the asset's real name and always wins the title slot;
    // Kaleidoscope's curated name becomes a subtitle. Otherwise
    // RAREALIEN.FROGCEPTION displays as "THE XCP FROGCEPTION".
    rec.curatedName    = kEntry.title;
    rec.title          = a.asset_longname || kEntry.title;
    rec.text           = kEntry.text;
    rec.artist         = kEntry.artist;
    rec.tags           = kEntry.tags;
    rec.ipfsCid        = kEntry.ipfsCid;
    rec.kaleidoscopeId = kEntry.kaleidoscopeId;
    rec.sources.push("kaleidoscope");
  }

  /* --- inline stamp media: decoded locally, no network --- */
  if (cls.kind === KIND.STAMP_INLINE) {
    rec.isStamp = true;
    rec.media.dataUri = cls.dataUri;
    rec.media.image = cls.dataUri;
    rec.media.imageMime = cls.mime;
    rec.media.dims = cls.dims;
    rec.sources.push("description:inline-base64");
  }

  /* --- metadata JSON pointer --- */
  let meta = null;
  if (cls.kind === KIND.JSON_URL) {
    const got = await fetchJson(cls.url);
    if (got.ok) {
      meta = interpretMetadata(got.json);
      rec.sources.push(`metadata-json:${new URL(got.url).hostname}`);
    } else {
      rec.warnings.push(`metadata JSON unreachable (${got.reason}): ${cls.originalUrl}`);
    }
  } else if (cls.kind === KIND.JSON_INLINE) {
    meta = interpretMetadata(cls.json);
    rec.sources.push("description:inline-json");
  } else if (cls.kind === KIND.PLAINTEXT) {
    rec.text = cls.text;
    rec.sources.push("description:plaintext");
  } else if (cls.kind === KIND.ORD_POINTER) {
    rec.warnings.push("ordinals pointer description; not resolvable via Counterparty");
    rec.text = null;
  }

  // Kaleidoscope's curated title/text/artist outrank whatever the on-chain
  // metadata says, so these only fill gaps.
  if (meta) {
    rec.title ??= meta.title;
    rec.text ||= meta.text || null;
    rec.descriptionHtml = meta.descriptionHtml;
    rec.website = meta.website;
    rec.attributes = meta.attributes;
  }

  /* --- stamp classification + fallback imagery --- */
  const needStampLookup = rec.numeric || cls.kind === KIND.STAMP_EMPTY || cls.kind === KIND.STAMP_INLINE || cls.kind === KIND.EMPTY;
  if (needStampLookup) {
    const s = await lookupStamp(a.asset);
    if (s) {
      rec.isStamp = true;
      rec.stampNumber = s.stamp ?? null;
      rec.stampMimetype = s.stamp_mimetype ?? null;
      if (!rec.title && s.stamp != null) rec.title = `Stamp #${s.stamp}`;
      if (s.stamp_mimetype === "text/html") rec.media.htmlUrl = s.stamp_url ?? null;
      if (!rec.media.image && s.stamp_url) {
        rec.media.image = s.stamp_url;
        rec.media.imageMime = s.stamp_mimetype ?? mimeFromUrl(s.stamp_url);
      }
      rec.sources.push("stampchain");
    }
  }

  /* --- resolve remaining media, only where a better source hasn't already --- */
  //
  // Source priority for the displayed artwork:
  //   1. manual override
  //   2. inline on-chain stamp data  (for stamps this IS the embedded artwork)
  //   3. Kaleidoscope web rendition  (already applied above)
  //   4. metadata JSON, largest rendition
  //   5. cdn.xcp.io /img/full        (NEVER /img/icon)
  //   6. stampchain stamp_url
  //
  const haveGoodImage = !!(rec.media.image && (kEntry || cls.kind === KIND.STAMP_INLINE));

  if (!SKIP_PROBE && !haveGoodImage) {
    const candidates = [];
    const push = u => { if (typeof u === "string" && /^https?:\/\//i.test(u)) candidates.push(normalizeArweave(u)); };
    if (meta) { push(meta.image); push(meta.hiResUrl); meta.alternates.forEach(push); }
    if (rec.media.image && /^https?:/i.test(rec.media.image)) push(rec.media.image);

    const uniq = [...new Set(candidates)];
    const probes = [];
    for (const u of uniq) { probes.push(await probeMedia(u)); await sleep(120); }

    const { thumb, display, original } = chooseRenditions(probes);
    if (display) {
      rec.media.image = display.url;
      rec.media.imageMime = display.mime;
      rec.media.dims = display.dims;
      if (thumb && thumb.url !== display.url) { rec.media.thumb = thumb.url; rec.media.thumbDims = thumb.dims; }
      if (original) { rec.media.original = original.url; rec.media.originalDims = original.dims; }
    } else if (uniq.length) {
      rec.warnings.push(`no image rendition resolved from ${uniq.length} candidate URL(s)`);
    }

    /* --- fallback: xcp.io mirror, for assets whose metadata host is dead --- */
    if (!rec.media.image && !rec.media.htmlUrl) {
      const mirror = await probeXcpIo(a.asset);
      if (mirror) {
        const { full, icon } = mirror;
        if (full.kind === "video") {
          rec.media.animationUrl = full.url;
          rec.media.animationMime = full.mime;
          if (icon) { rec.media.image = icon.url; rec.media.imageMime = icon.mime; rec.media.dims = icon.dims; }
        } else {
          // The full file is ALWAYS the display image, however large. An earlier
          // version swapped to /img/icon/ for files over 1.5MB, which silently
          // reduced every multi-megabyte piece to a 48px icon. The icon is only
          // ever a grid thumbnail, never the artwork.
          rec.media.image = full.url;
          rec.media.imageMime = full.mime;
          rec.media.dims = full.dims;
          rec.media.originalDims = full.dims;
          // The xcp.io icon is 48x48. It is never a usable grid image, only a
          // video poster, so it is deliberately NOT recorded as a thumbnail.
        }
        rec.sources.push("xcp.io-mirror");
        rec.recovered = true;
      }
    }

    // Video / audio referenced by the metadata (Kaleidoscope's wins if present).
    for (const [srcUrl, key] of [[rec.media.animationUrl ? null : meta?.animationUrl, "animation"], [meta?.audioUrl, "audio"]]) {
      if (!srcUrl) continue;
      const p = await probeMedia(srcUrl);
      if (p.ok) {
        if (p.kind === "video") { rec.media.animationUrl = p.url; rec.media.animationMime = p.mime; }
        else if (p.kind === "audio") { rec.media.audioUrl = p.url; rec.media.audioMime = p.mime; }
        else if (p.kind === "image" && !rec.media.image) { rec.media.image = p.url; rec.media.imageMime = p.mime; rec.media.dims = p.dims; }
      } else rec.warnings.push(`${key} URL unreachable: ${srcUrl}`);
      await sleep(120);
    }
  }

  /* --- manual overrides win over everything --- */
  const ov = overrides[a.asset];
  if (ov) {
    if (ov.image) {
      // Probe the override so scaling and dimensions come from the real file
      // rather than being asserted by hand.
      const p = SKIP_PROBE ? null : await probeMedia(ov.image);
      if (p?.ok) {
        rec.media.image = p.url; rec.media.imageMime = p.mime; rec.media.dims = p.dims;
        if (p.kind === "video") { rec.media.animationUrl = p.url; rec.media.animationMime = p.mime; }
      } else {
        rec.media.image = ov.image;
        rec.media.imageMime = ov.imageMime ?? mimeFromUrl(ov.image);
        rec.media.dims = ov.dims ?? rec.media.dims;
        if (p && !p.ok) rec.warnings.push(`override image did not resolve (${p.reason})`);
      }
      rec.media.original = null; rec.media.originalDims = null;   // override IS the original
    }
    if (ov.thumb) {
      // Only honour an override thumbnail if it clears the grid size floor.
      const tp = SKIP_PROBE ? null : await probeMedia(ov.thumb);
      if (!tp || (tp.ok && Math.max(tp.dims?.w ?? 0, tp.dims?.h ?? 0) >= MIN_THUMB_DIM)) {
        rec.media.thumb = tp?.url ?? ov.thumb;
        if (tp?.dims) rec.media.thumbDims = tp.dims;
      }
    }
    if (ov.artist)       rec.artist = ov.artist;
    if (ov.note)         rec.note = ov.note;
    if (ov.original)     rec.media.original = ov.original;
    if (ov.animationUrl) { rec.media.animationUrl = ov.animationUrl; rec.media.animationMime = ov.animationMime ?? mimeFromUrl(ov.animationUrl); }
    if (ov.audioUrl)     { rec.media.audioUrl = ov.audioUrl; rec.media.audioMime = ov.audioMime ?? mimeFromUrl(ov.audioUrl); }
    if (ov.title)        rec.title = ov.title;
    if (ov.text)         rec.text = ov.text;
    if (ov.pixelate !== undefined) rec.pixelateForced = !!ov.pixelate;
    rec.sources.push("manual-override");
  }

  /* --- animation: does this piece actually move? --- */
  //
  // Kaleidoscope's WebP renditions strip animation, so an animated GIF shown via
  // the web tier is a frozen still. Detect real animation and record the original
  // file so the front end can swap it in. Inline stamp data is already the
  // original, so it can be checked without a network call.
  if (!SKIP_PROBE && !rec.media.animationUrl) {
    const gifOriginal =
      (rec.media.originalMime === "image/gif" && rec.media.original) ||
      (rec.media.imageMime === "image/gif" && rec.media.image) || null;

    if (cls.kind === KIND.STAMP_INLINE && cls.mime === "image/gif") {
      const raw = Buffer.from(cls.dataUri.split(",")[1], "base64");
      const g = gifFrameCount(raw);
      rec.animated = g ? g.animated : false;
      if (rec.animated) rec.animatedUrl = rec.media.dataUri;   // already inline
    } else if (gifOriginal) {
      const a2 = await probeAnimation(gifOriginal);
      // `null` means we couldn't see far enough into the file to be sure. Treat
      // that as animated: serving the original for a still only wastes bandwidth,
      // whereas serving a still for an animation loses the artwork.
      rec.animated = a2.animated === null ? true : a2.animated;
      rec.animatedUnverified = a2.animated === null;
      if (rec.animated) rec.animatedUrl = gifOriginal;
      await sleep(120);
    } else {
      rec.animated = false;
    }
  }

  /* --- titles and scaling --- */
  //
  // Subassets arrive from Counterparty as numeric IDs with the readable name in
  // asset_longname. Falling back to the numeric ID printed things like
  // "A17176017992433601881" instead of "CSHGRBORANGE.GROUNDHOGMOON", so the
  // longname always takes precedence over the raw ID.
  if (!rec.title) {
    if (rec.assetLongname) rec.title = rec.assetLongname;
    else if (rec.text) rec.title = rec.text.split("\n")[0].slice(0, 70);
    else if (rec.numeric && rec.stampNumber) rec.title = `Stamp #${rec.stampNumber}`;
    else rec.title = a.asset;
  }
  // The longname outranks EVERY other title source — Kaleidoscope's curated name,
  // the metadata JSON's name, all of it. Whatever it displaced is preserved as the
  // subtitle. Without this, RAREALIEN.FROGCEPTION shows as "THE XCP FROGCEPTION"
  // and RAREBEAR.POLARMEME as "The Rare Polar Bear Meme".
  if (rec.assetLongname && rec.title !== rec.assetLongname) {
    if (rec.title && rec.title !== a.asset) rec.curatedName ??= rec.title;
    rec.title = rec.assetLongname;
  }
  // Decide scaling from the TRUE original dimensions, never from a downscaled
  // thumbnail: a 96x96 icon of a 470x650 painting must still render smooth,
  // while a 28x37 stamp must render nearest-neighbour.
  const trueDims = rec.media.originalDims ?? rec.media.dims;
  rec.pixelate = rec.pixelateForced !== undefined
    ? rec.pixelateForced
    : shouldPixelate({ dims: trueDims, mime: rec.media.imageMime, isStamp: rec.isStamp && !rec.media.originalDims });

  /* --- supply, in both representations, plus rarity --- */
  //
  // Effective supply counts separately ownable things: the smallest unit is one,
  // exactly as a 1-of-1 is one. A divisible asset therefore has 1e8 ownable units
  // per whole unit, which is why a divisible asset with supply 1 is common rather
  // than rare. This equals the chain's own raw integer.
  rec.supplyAtomic = effectiveSupply(rec.supplyUnits, rec.divisible);
  rec.effectiveSupply = rec.supplyAtomic;
  rec.rarity = rarityOf({ supply: rec.supplyUnits, divisible: rec.divisible, locked: rec.locked });

  rec.hasMedia = !!(rec.media.image || rec.media.animationUrl || rec.media.audioUrl || rec.media.htmlUrl);
  if (!rec.hasMedia) rec.warnings.push("no media resolved");
  rec.ownedByArtist = ownerSet.has(a.owner);

  return rec;
}

/* ---------------- main ---------------- */

async function main() {
  const addresses = cfg.addresses.map(a => (typeof a === "string" ? a : a.address));
  const ownerSet = new Set(addresses);
  console.log(`Indexing ${addresses.length} address(es)\n`);

  // Kaleidoscope registry: one fetch, cached, indexed by asset name and longname.
  let kaleido = null;
  try {
    const reg = await fetchRegistry({ cacheFile: path.join(ROOT, "data/kaleidoscope-cache.json") });
    kaleido = indexByAsset(reg.items);
    console.log(`  Kaleidoscope: ${reg.items.length} media items${reg.fromCache ? " (cached)" : ""}${reg.stale ? " STALE" : ""}`);
  } catch (e) {
    console.error(`  Kaleidoscope unavailable: ${e.message}`);
  }

  let raw = [];
  if (OFFLINE) {
    console.log("  --offline: reusing cached data/issued-raw.json");
  } else
  for (const addr of addresses) {
    // TokenScan is the primary asset-list source: it mirrors Counterparty over
    // ordinary HTTPS, exposes asset_longname (so subassets resolve), and stays up
    // when the public node on port 4000 does not.
    try {
      const info = await addressInfo(addr).catch(() => null);
      if (info?.assets) console.log(`  ${addr}: ${info.assets.owned} owned / ${info.assets.held} held`);
      console.log(`  walking issuance history via tokenscan ...`);
      const events = await allIssuances(addr, {
        onProgress: (n, t) => { if (n % 400 === 0 || n === t) console.log(`    ${n}/${t} issuance events`); },
      });
      const rows = collapseIssuances(events);
      console.log(`    ${events.length} events -> ${rows.length} distinct assets`);
      raw.push(...rows.map(r => ({ ...r, _sourceAddress: addr })));
    } catch (e) {
      console.error(`    tokenscan FAILED: ${e.message}`);
      // Fall back to the Counterparty node, then to the cached snapshot.
      try {
        const rows = await xcpAll(`/v2/addresses/${addr}/assets/issued`);
        console.log(`    counterparty fallback: ${rows.length} assets`);
        raw.push(...rows.map(r => ({ ...r, _sourceAddress: addr })));
      } catch (e2) {
        console.error(`    counterparty also failed: ${e2.message}`);
        const cachePath = path.join(ROOT, "data/issued-raw.json");
        if (fs.existsSync(cachePath)) {
          console.error(`    falling back to cached data/issued-raw.json`);
          raw.push(...JSON.parse(fs.readFileSync(cachePath, "utf8")));
        }
      }
    }
  }

  // Merge with the previous snapshot so an interrupted or partial walk never
  // shrinks the collection — assets only ever get added or refreshed, never lost
  // because the public node dropped a page mid-pagination.
  const prior = readJsonSafe(path.join(ROOT, "data/issued-raw.json")) ?? [];
  const merged = new Map(prior.map(r => [r.asset, r]));
  for (const r of raw) merged.set(r.asset, r);      // fresh rows win
  raw = [...merged.values()];
  if (prior.length && raw.length > 0) {
    const added = raw.length - prior.length;
    if (added > 0) console.log(`  (+${added} new asset(s) since last snapshot)`);
  }
  fs.writeFileSync(path.join(ROOT, "data/issued-raw.json"), JSON.stringify(raw, null, 1));

  let work = raw;
  if (ONLY)  work = work.filter(r => r.asset === ONLY);
  if (LIMIT) work = work.slice(0, LIMIT);

  console.log(`\nResolving ${work.length} assets ...`);
  const out = [];
  for (let i = 0; i < work.length; i++) {
    const a = work[i];
    try {
      const rec = await resolveAsset(a, ownerSet, kaleido);
      out.push(rec);
      const tag = rec.excluded ? "SKIP(token-op)" : rec.hasMedia ? "ok" : "NO MEDIA";
      const od = rec.media.originalDims ?? rec.media.dims;
      const dim = od ? `${od.w}x${od.h}` : "-";
      const src = rec.sources.includes("kaleidoscope") ? "kaleido"
                : rec.sources.includes("description:inline-base64") ? "on-chain"
                : rec.sources.includes("manual-override") ? "override"
                : rec.sources.includes("xcp.io-mirror") ? "xcp.io"
                : rec.sources.find(x => x.startsWith("metadata-json")) ? "json" : "-";
      const label = (rec.assetLongname || a.asset).slice(0, 26).padEnd(26);
      console.log(`  [${String(i + 1).padStart(3)}/${work.length}] ${label} ${tag.padEnd(14)} ${dim.padEnd(11)} ${(rec.pixelate ? "pixel" : "smooth").padEnd(7)} ${src}`);
    } catch (e) {
      console.error(`  [${i + 1}] ${a.asset} ERROR ${e.message}`);
      out.push({ asset: a.asset, error: String(e.message), excluded: true, excludedReason: "resolve_error" });
    }
  }

  const artworks = out.filter(r => !r.excluded);
  const tokenOps = out.filter(r => r.excludedReason === "src20_token_operation");

  const payload = {
    generatedAt: new Date().toISOString(),
    addresses,
    counts: {
      totalIssued: raw.length,
      resolved: out.length,
      artworks: artworks.length,
      withMedia: artworks.filter(r => r.hasMedia).length,
      withoutMedia: artworks.filter(r => !r.hasMedia).length,
      stamps: artworks.filter(r => r.isStamp).length,
      counterparty: artworks.filter(r => !r.isStamp).length,
      tokenOpsExcluded: tokenOps.length,
      fromKaleidoscope: artworks.filter(r => r.sources.includes("kaleidoscope")).length,
      withVideo: artworks.filter(r => r.media.animationUrl).length,
      animatedGifs: artworks.filter(r => r.animated && !r.media.animationUrl).length,
      subassets: artworks.filter(r => r.assetLongname).length,
    },
    artworks,
    tokenOps: tokenOps.map(r => ({ asset: r.asset, ...r.tokenOp })),
  };

  fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "data/artworks.json"), JSON.stringify(payload, null, 1));

  console.log("\n=== summary ===");
  for (const [k, v] of Object.entries(payload.counts)) console.log(`  ${k.padEnd(18)} ${v}`);
  const missing = artworks.filter(r => !r.hasMedia).map(r => r.asset);
  if (missing.length) console.log(`\n  no media (${missing.length}): ${missing.join(", ")}`);
  console.log(`\nwrote data/artworks.json`);
}

main().catch(e => { console.error(e); process.exit(1); });
