/**
 * Builds data/market.json and data/holders.json.
 *
 * Market  = open dispensers + open DEX orders for every indexed artwork.
 * Holders = who holds what, aggregated into a collector leaderboard.
 *
 * Dispensers have two independent sources: Counterparty directly, and
 * stampchain's address-dispenser endpoint (which is CORS-open and reachable
 * where the Counterparty node's non-standard port is not). Whichever answers
 * gets used, so a firewalled environment still produces a usable market view.
 */

import fs from "node:fs";
import path from "node:path";
import { xcp } from "../lib/xcpfetch.mjs";
import { allOrders, normalizeOrder } from "../lib/tokenscan.mjs";
import { scanAssets, priceSignals } from "../lib/markets.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const STAMPCHAIN = "https://stampchain.io/api/v2";
const sleep = ms => new Promise(r => setTimeout(r, ms));
function readJsonSafe(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config/wallets.json"), "utf8"));
const index = JSON.parse(fs.readFileSync(path.join(ROOT, "data/artworks.json"), "utf8"));
const artworks = index.artworks.filter(a => !a.excluded);
const addresses = cfg.addresses.map(a => (typeof a === "string" ? a : a.address));
const EXCLUDE = new Set([...(cfg.excludeFromLeaderboard || []), ...addresses]);

/**
 * Stampchain fetch with explicit rate-limit handling.
 *
 * The previous version returned null on any non-OK response, so a 429 was
 * indistinguishable from "this asset has no holders". A rate-limited run then
 * looked like a successful run that found nothing, and wrote a near-empty
 * leaderboard over a good one. 429 and 503 now back off and retry, and a
 * persistent failure is reported as an error rather than as absence.
 */
async function scJson(p, { timeout = 25000, retries = 4 } = {}) {
  for (let i = 0; i < retries; i++) {
    try {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), timeout);
      const r = await fetch(STAMPCHAIN + p, { signal: c.signal });
      clearTimeout(t);
      if (r.status === 429 || r.status === 503) {
        await sleep(5000 * (i + 1));
        continue;
      }
      if (r.status === 404) return null;
      if (!r.ok) { if (i === retries - 1) return { __error: `http ${r.status}` }; await sleep(1500 * (i + 1)); continue; }
      return await r.json();
    } catch (e) {
      if (i === retries - 1) return { __error: String(e.message || e) };
      await sleep(1500 * (i + 1));
    }
  }
  return { __error: "rate limited" };
}

async function btcPrice() {
  const h = await scJson("/health");
  const p = h?.metadata?.btcPrice ?? h?.btcPrice;
  if (p) return Number(p);
  try {
    const r = await fetch("https://api.coinbase.com/v2/prices/BTC-USD/spot");
    if (r.ok) return Number((await r.json())?.data?.amount) || null;
  } catch {}
  return null;
}

/* ---------------- dispensers ---------------- */

async function dispensersFromStampchain() {
  const out = [];
  for (const addr of addresses) {
    const d = await scJson(`/stamps/dispensers/${addr}?limit=500`);
    for (const row of d?.data ?? []) {
      // status "unknown"/0 means open; a set close_block_index means closed.
      const closed = row.close_block_index != null || row.status === 10 || row.status === "closed";
      if (closed) continue;
      if (Number(row.give_remaining) <= 0) continue;
      out.push({
        asset: row.cpid,
        source: row.source,
        satoshirate: Number(row.satoshirate),
        give_quantity: Number(row.give_quantity),
        give_remaining: Number(row.give_remaining),
        escrow_quantity: Number(row.escrow_quantity ?? 0),
        tx_hash: row.tx_hash,
        origin: "stampchain",
      });
    }
    await sleep(400);
  }
  return out;
}

async function dispensersFromCounterparty() {
  const out = [];
  for (const addr of addresses) {
    try {
      const d = await xcp(`/v2/addresses/${addr}/dispensers?status=open&limit=500`, { retries: 2 });
      for (const row of d?.result ?? []) {
        if (Number(row.give_remaining) <= 0) continue;
        out.push({
          asset: row.asset,
          source: row.source,
          satoshirate: Number(row.satoshirate),
          give_quantity: Number(row.give_quantity),
          give_remaining: Number(row.give_remaining),
          escrow_quantity: Number(row.escrow_quantity ?? 0),
          tx_hash: row.tx_hash,
          origin: "counterparty",
        });
      }
    } catch (e) { console.error(`  dispensers via counterparty failed for ${addr}: ${e.message}`); }
    await sleep(300);
  }
  return out;
}

/* ---------------- orders ---------------- */

async function openOrders() {
  const out = [];
  for (const a of artworks) {
    try {
      const d = await xcp(`/v2/assets/${encodeURIComponent(a.asset)}/orders?status=open&limit=50`, { retries: 1 });
      for (const o of d?.result ?? []) {
        if (o.give_asset !== a.asset) continue;
        out.push({
          give_asset: o.give_asset, give_quantity: Number(o.give_quantity), give_remaining: Number(o.give_remaining),
          get_asset: o.get_asset, get_quantity: Number(o.get_quantity), get_remaining: Number(o.get_remaining),
          source: o.source, tx_hash: o.tx_hash,
        });
      }
    } catch { /* asset has no market; keep going */ }
    await sleep(180);
  }
  return out;
}

/* ---------------- holders ---------------- */

/**
 * Holder lists come from stampchain first. It mirrors Counterparty balances for
 * BOTH stamps and plain Counterparty assets, is CORS-open, and answers on 443 —
 * so it works in environments where the Counterparty node's port 4000 doesn't.
 * Counterparty itself is the fallback.
 *
 * Field names differ between them: stampchain returns `amt`, Counterparty returns
 * `quantity`. Both are raw integers for divisible assets.
 */
async function holdersFor(asset, divisible) {
  // Both sources report divisible balances as raw integers scaled by 1e8, so the
  // same divisor applies either way. Skipping it lets a 69,000,000-supply token
  // dwarf every real edition count in the leaderboard.
  const scale = divisible ? 1e8 : 1;

  const d = await scJson(`/stamps/${encodeURIComponent(asset)}/holders?limit=500`);
  if (d?.__error) return null;            // fetch failed — NOT the same as no holders
  const rows = d?.data;
  if (Array.isArray(rows) && rows.length) {
    return rows
      .filter(h => h.address && Number(h.amt) > 0)
      .map(h => ({ address: h.address, units: Number(h.amt) / scale }));
  }
  try {
    const x = await xcp(`/v2/assets/${encodeURIComponent(asset)}/holders?limit=500`, { retries: 1 });
    return (x?.result ?? [])
      .filter(h => h.address && Number(h.quantity) > 0)
      .map(h => ({ address: h.address, units: Number(h.quantity) / scale }));
  } catch { return null; }
}

async function holders() {
  const byAsset = {};
  const agg = new Map();   // address -> { distinctAssets, totalUnits, assets[] }
  let failed = 0;

  for (let i = 0; i < artworks.length; i++) {
    const a = artworks[i];
    const clean = await holdersFor(a.asset, a.divisible);
    if (!clean) { failed++; continue; }

    const external = clean.filter(h => !EXCLUDE.has(h.address));
    byAsset[a.asset] = {
      count: external.length,
      total: clean.length,
      // `quantity` is kept in human units here so the UI never rescales twice.
      top: [...external].sort((x, y) => y.units - x.units).slice(0, 12)
             .map(h => ({ address: h.address, quantity: h.units })),
    };

    for (const h of external) {
      const cur = agg.get(h.address) ?? { address: h.address, distinctAssets: 0, editions: 0, totalUnits: 0, assets: [] };
      cur.distinctAssets += 1;
      // Only count editions of indivisible pieces. Divisible assets behave like
      // fungible tokens and their balances aren't comparable to edition counts.
      if (!a.divisible) cur.editions += h.units;
      cur.totalUnits += h.units;
      cur.assets.push(a.asset);
      agg.set(h.address, cur);
    }

    if ((i + 1) % 15 === 0) console.log(`  holders: ${i + 1}/${artworks.length}`);
    await sleep(220);
  }
  if (failed) console.log(`  (${failed} of ${artworks.length} assets returned no holder data)`);

  // Keep everyone. Capping at 250 hid every single-piece collector, which made
  // the entry tier look empty and understated the real collector base.
  const leaderboard = [...agg.values()]
    .sort((x, y) => y.distinctAssets - x.distinctAssets || y.editions - x.editions);

  return { byAsset, leaderboard };
}

/* ---------------- main ---------------- */

async function main() {
  const only = process.argv.includes("--holders-only") ? "holders"
             : process.argv.includes("--market-only") ? "market" : "both";

  const price = await btcPrice();
  console.log(`BTC price: ${price ?? "unknown"}`);

  if (only !== "holders") {
    // Market discovery is keyed by ASSET, not by address. Querying the artist's
    // own address only ever finds orders the artist placed, which made every
    // market opened by somebody else invisible — PUDSEC had 22 orders and the
    // address-scoped query found one.
    const assets = artworks.map(a => a.asset);
    console.log(`\nScanning ${assets.length} assets for orders, dispensers and markets...`);

    let withActivity = 0;
    const scan = await scanAssets(assets, {
      onProgress: (n, total, asset, rec) => {
        if (rec.orders.length || rec.dispensers.length || rec.markets.length) withActivity++;
        if (n % 25 === 0 || n === total) console.log(`  ${n}/${total} scanned, ${withActivity} with market activity`);
      },
    });

    // Flatten into the shapes the site reads, keeping units and denominations.
    const dispensers = [];
    const orders = [];
    const signalsByAsset = {};

    for (const [asset, rec] of Object.entries(scan)) {
      const art = artworks.find(a => a.asset === asset);
      for (const d of rec.dispensers) {
        if (!d.open) continue;
        dispensers.push({
          asset, assetLongname: art?.assetLongname ?? null,
          source: d.source,
          priceBtc: d.priceBtc, priceSats: d.priceSats,
          giveUnits: d.giveUnits, remainingUnits: d.remainingUnits,
          txHash: d.txHash, origin: "tokenscan",
        });
      }
      for (const o of rec.orders) {
        if (o.status !== "open") continue;
        orders.push({ asset, ...o });
      }
      if (rec.signals?.length) signalsByAsset[asset] = rec.signals;
    }

    // Order history for the whole wallet set, for the "sold via exchange" view.
    let orderHistory = [];
    for (const addr of addresses) {
      try {
        const raw = await allOrders(addr);
        orderHistory.push(...raw.map(normalizeOrder));
      } catch (e) { console.error(`  order history failed for ${addr}: ${e.message}`); }
    }
    const seenTx = new Set();
    orderHistory = orderHistory.filter(o => (seenTx.has(o.tx_hash) ? false : seenTx.add(o.tx_hash)));

    const byStatus = orderHistory.reduce((m, o) => (m[o.status] = (m[o.status] || 0) + 1, m), {});
    console.log(`  ${dispensers.length} open dispensers, ${orders.length} open orders`);
    console.log(`  ${Object.keys(signalsByAsset).length} assets with price signals`);
    console.log(`  ${orderHistory.length} historical orders`, byStatus);

    fs.writeFileSync(path.join(ROOT, "data/market.json"),
      JSON.stringify({
        generatedAt: new Date().toISOString(),
        btcPrice: price,
        units: "human",          // every quantity here is in human units
        // Provenance so the UI can state truthfully where the dispenser rows came
        // from. Without this the freshness badge read two keys that only ever exist
        // at runtime, so it could never report anything but "Indexed".
        dispensersSource: dispensers.length ? (dispensers[0].origin || "scan") : null,
        dispensersFetchedAt: new Date().toISOString(),
        dispensers, orders, orderHistory, signalsByAsset,
      }, null, 1));
    console.log("wrote data/market.json");
  }

  if (only !== "market") {
    console.log("\nHolders…");
    const h = await holders();
    const newAssets = Object.keys(h.byAsset).length;
    console.log(`  ${h.leaderboard.length} distinct collectors across ${newAssets} assets`);

    // Never let a partial run clobber a better snapshot. A rate-limited pass can
    // finish with a fraction of the coverage, and silently replacing good data with
    // it is how the leaderboard collapsed from 598 collectors over 452 assets down
    // to 412 over 175. Same guard the asset index already has.
    const outPath = path.join(ROOT, "data/holders.json");
    const prior = readJsonSafe(outPath);
    const priorAssets = prior ? Object.keys(prior.byAsset || {}).length : 0;

    if (prior && newAssets < priorAssets * 0.9 && !process.argv.includes("--force")) {
      console.error(`  REFUSING TO WRITE: this run covered ${newAssets} assets, the existing snapshot has ${priorAssets}.`);
      console.error(`  That points at rate limiting or an interruption, not a real change.`);
      console.error(`  Keeping the existing file. Re-run later, or pass --force to override.`);
      return;
    }

    fs.writeFileSync(outPath,
      JSON.stringify({ generatedAt: new Date().toISOString(), assetsCovered: newAssets, ...h }, null, 1));
    console.log(`wrote data/holders.json (${newAssets} assets)`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
