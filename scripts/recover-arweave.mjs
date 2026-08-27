/**
 * Bulk artwork recovery from Arweave for assets whose metadata host has died.
 *
 * easyasset.art now returns HTTP 200 with an empty body, so the JSON wrappers
 * that pointed at each artwork are gone for good. The image files themselves
 * were uploaded to Arweave as path manifests and survive permanently.
 *
 * Recovery route:
 *   1. Page Arweave's GraphQL for every manifest published by the EasyAsset
 *      wallet. Each carries an `asset_name` tag and often an `artist` tag.
 *   2. Fetch each manifest as RAW json (arweave.net/raw/<txid> — the bare
 *      gateway URL resolves the manifest's index file instead of the manifest).
 *   3. Inside `paths`, pick the largest real rendition: prefer _hires, then
 *      _image, and treat _thumb as a last resort only.
 *   4. Verify the chosen file resolves and beats what the site already shows,
 *      so a downscaled mirror copy is never swapped for another small file.
 *
 * Writes config/overrides.json (merging with anything already there).
 *
 * Run: node scripts/recover-arweave.mjs [--dry]
 */

import fs from "node:fs";
import path from "node:path";
import { probeMedia } from "../lib/media.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const GQL = "https://arweave.net/graphql";
const EASYASSET_WALLET = "VkRTD2cveAY3wLCbF30vkHFSRGW6eualcVqH_Nsmzss";
const DRY = process.argv.includes("--dry");

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function gql(query, { retries = 4 } = {}) {
  for (let i = 0; i < retries; i++) {
    try {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), 60000);
      const r = await fetch(GQL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
        signal: c.signal,
      });
      clearTimeout(t);
      if (!r.ok) throw new Error("http " + r.status);
      const j = await r.json();
      if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 200));
      return j.data;
    } catch (e) {
      if (i === retries - 1) throw e;
      await sleep(2000 * (i + 1));
    }
  }
}

/** Every manifest the EasyAsset wallet ever published, indexed by asset name. */
async function loadManifests(wanted) {
  const byName = new Map();
  let cursor = null, page = 0;
  const remaining = new Set(wanted);

  while (true) {
    const after = cursor ? `, after: "${cursor}"` : "";
    // The tag filter matters: this wallet has tens of thousands of transactions
    // and most are transfers or deploys. Filtering to Type=manifest server-side,
    // and stopping once every target is found, turns thousands of pages into a few.
    const data = await gql(`{
      transactions(
        owners: ["${EASYASSET_WALLET}"],
        tags: [{ name: "Type", values: ["manifest"] }],
        first: 100${after}
      ) {
        pageInfo { hasNextPage }
        edges { cursor node { id tags { name value } } }
      }
    }`);

    const tx = data?.transactions;
    const edges = tx?.edges ?? [];
    for (const e of edges) {
      const tags = Object.fromEntries(e.node.tags.map(t => [t.name, t.value]));
      if (tags.Type !== "manifest") continue;
      const name = (tags.asset_name || "").trim();
      if (!name) continue;
      // First manifest per name wins; later ones are usually re-uploads.
      const key = name.toUpperCase();
      if (!byName.has(key)) byName.set(key, { id: e.node.id, artist: (tags.artist || "").trim() || null, name });
      remaining.delete(key);
      if (key.includes(".")) remaining.delete(key.split(".").pop());
    }

    cursor = edges.length ? edges[edges.length - 1].cursor : null;
    page++;
    process.stderr.write(`\r  page ${page}, ${byName.size} manifests, ${remaining.size} targets outstanding`);
    if (!remaining.size) { process.stderr.write(" - all found\n"); break; }
    if (!tx?.pageInfo?.hasNextPage || !cursor) break;
    await sleep(120);
  }
  process.stderr.write("\n");
  return byName;
}

/** Raw manifest JSON. The bare gateway URL serves the index file, not the manifest. */
async function fetchManifest(txid) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 30000);
    const r = await fetch(`https://arweave.net/raw/${txid}`, { signal: c.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

/**
 * Rank the files inside a manifest. EasyAsset's naming convention is
 * <slug>_thumb / _image / _hires, so preference order is explicit rather than
 * guessed — _thumb is what has been making the site look soft.
 */
function rankPaths(paths) {
  const entries = Object.entries(paths || {}).map(([name, v]) => ({ name, id: v?.id }))
    .filter(e => e.id);
  const score = n => /_hires\./i.test(n) ? 3 : /_image\./i.test(n) ? 2 : /_thumb\./i.test(n) ? 0 : 1;
  return entries.sort((a, b) => score(b.name) - score(a.name));
}

const maxDim = d => Math.max(d?.w ?? 0, d?.h ?? 0);

async function main() {
  const index = JSON.parse(fs.readFileSync(path.join(ROOT, "data/artworks.json"), "utf8"));
  const overridesPath = path.join(ROOT, "config/overrides.json");
  const overrides = JSON.parse(fs.readFileSync(overridesPath, "utf8"));

  const targets = index.artworks.filter(r =>
    /easyasset\.art/.test(String(r.descriptionRaw || "")) && !r.sources.includes("manual-override"));

  console.log(`Targets on the dead host: ${targets.length}`);
  console.log("Loading EasyAsset manifests from Arweave...");
  const wanted = new Set();
  for (const r of targets) {
    wanted.add(r.asset.toUpperCase());
    if (r.assetLongname) {
      wanted.add(r.assetLongname.toUpperCase());
      wanted.add(r.assetLongname.toUpperCase().split(".").pop());
    }
  }
  const manifests = await loadManifests(wanted);
  console.log(`  ${manifests.size} manifests indexed\n`);

  let recovered = 0, noManifest = 0, notBetter = 0, failed = 0;

  for (let i = 0; i < targets.length; i++) {
    const r = targets[i];
    const label = (r.assetLongname || r.asset).slice(0, 30).padEnd(30);
    const currentBest = maxDim(r.media.originalDims ?? r.media.dims);

    // Match on the subasset longname first, then the plain asset name, then the
    // final segment of a longname (EasyAsset sometimes tagged only the child).
    const long = (r.assetLongname || "").toUpperCase();
    const child = long.includes(".") ? long.split(".").pop() : null;
    const m = manifests.get(long) || manifests.get(r.asset.toUpperCase()) || (child ? manifests.get(child) : null);

    if (!m) { console.log(`  [${i + 1}/${targets.length}] ${label} no manifest`); noManifest++; continue; }

    const man = await fetchManifest(m.id);
    if (!man?.paths) { console.log(`  [${i + 1}/${targets.length}] ${label} manifest unreadable`); failed++; continue; }

    const ranked = rankPaths(man.paths);
    let chosen = null, chosenProbe = null;
    for (const cand of ranked) {
      const p = await probeMedia(`https://arweave.net/${cand.id}`, { timeout: 25000 });
      if (p.ok && p.kind === "image") { chosen = cand; chosenProbe = p; break; }
      await sleep(80);
    }

    if (!chosen) { console.log(`  [${i + 1}/${targets.length}] ${label} no usable file`); failed++; continue; }

    const gotDim = maxDim(chosenProbe.dims);
    // Only replace when this is genuinely a better file than what's shown now.
    if (gotDim && currentBest && gotDim <= currentBest) {
      console.log(`  [${i + 1}/${targets.length}] ${label} not an upgrade (${gotDim} <= ${currentBest})`);
      notBetter++;
      await sleep(100);
      continue;
    }

    // A separate thumb is only worth keeping if it's big enough for the grid.
    const thumbCand = ranked.find(c => /_thumb\./i.test(c.name) && c !== chosen);
    let thumbUrl = null;
    if (thumbCand) {
      const tp = await probeMedia(`https://arweave.net/${thumbCand.id}`, { timeout: 20000 });
      if (tp.ok && maxDim(tp.dims) >= 400) thumbUrl = tp.url;
    }

    overrides[r.asset] = {
      image: chosenProbe.url,
      ...(thumbUrl ? { thumb: thumbUrl } : {}),
      ...(m.artist ? { artist: m.artist } : {}),
      note: `Recovered from Arweave after easyasset.art went offline (manifest ${m.id}, file ${chosen.name}).`,
    };

    console.log(`  [${i + 1}/${targets.length}] ${label} RECOVERED ${chosenProbe.dims?.w}x${chosenProbe.dims?.h} (was ${currentBest || "?"}) ${chosen.name}`);
    recovered++;
    await sleep(120);
  }

  console.log(`\n=== recovery summary ===`);
  console.log(`  recovered      ${recovered}`);
  console.log(`  not an upgrade ${notBetter}`);
  console.log(`  no manifest    ${noManifest}`);
  console.log(`  failed         ${failed}`);

  if (DRY) { console.log("\n--dry: overrides.json not written"); return; }
  fs.writeFileSync(overridesPath, JSON.stringify(overrides, null, 1));
  console.log(`\nwrote config/overrides.json (${Object.keys(overrides).filter(k => !k.startsWith("_")).length} entries)`);
}

main().catch(e => { console.error(e); process.exit(1); });
