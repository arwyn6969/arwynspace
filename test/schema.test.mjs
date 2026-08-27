/**
 * Schema parity between the indexed snapshot and the live API routes.
 *
 * The site can be served two ways: from the indexer's snapshot in market.json, or
 * from the /api routes when deployed. Those paths emitted DIFFERENT shapes for the
 * same concepts, and one of them was wrong in a way no test could see, because the
 * routes have never executed anywhere: api/market.js passed Counterparty's raw
 * integers through under the field names the client reads as human units, so every
 * divisible dispenser would have rendered 1e8 too large on first deploy.
 *
 * Both routes now emit the indexer's canonical camelCase in human units. These
 * assertions pin that down, and additionally prove the client still renders the older
 * snake_case shape identically — so the tolerance in readOrder/readDispenser is a
 * safety net, not a load-bearing assumption.
 *
 * Usage:  node test/schema.test.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { ROOT, loadWithData, check, eq, ok, summary } from "./harness.mjs";

const { api, data } = loadWithData();
const M = data.market;
const artMap = new Map(data.artworks.artworks.filter((a) => !a.excluded).map((a) => [a.asset, a]));
const strip = (h) => h.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

console.log("Schema parity\n");

/* ------------------------------------------------- canonical shape is declared */

check("market.json declares its unit convention", () => {
  return eq(M.units, "human", "an undeclared convention is how the 1e8 bugs start");
});

check("api/market.js scales raw upstream quantities by divisibility", () => {
  const src = fs.readFileSync(path.join(ROOT, "api/market.js"), "utf8");
  ok(/divisible \? SATS : 1/.test(src), "route must derive a scale from divisibility");
  ok(/units: "human"/.test(src), "route must declare its unit convention");
  return ok(!/give_quantity: Number\(row\.give_quantity\)/.test(src),
    "route must not emit raw quantities under human-unit field names");
});

check("api/market.js emits the provenance keys the freshness badge reads", () => {
  const src = fs.readFileSync(path.join(ROOT, "api/market.js"), "utf8");
  ok(/dispensersSource/.test(src), "dispensersSource");
  return ok(/dispensersFetchedAt/.test(src), "dispensersFetchedAt");
});

check("api/market.js matches orders on both sides of the trade", () => {
  const src = fs.readFileSync(path.join(ROOT, "api/market.js"), "utf8");
  return ok(/o\.give_asset !== asset && o\.get_asset !== asset/.test(src),
    "a one-sided order filter hides trades where the art was bought");
});

/* ----------------------------------------- the client renders both shapes alike */

/** Recast a canonical dispenser into the legacy snake_case the old route emitted. */
const asLegacyDispenser = (d) => ({
  asset: d.asset,
  source: d.source,
  satoshirate: d.priceSats,
  give_quantity: d.giveUnits,
  give_remaining: d.remainingUnits,
  asset_longname: d.assetLongname,
  tx_hash: d.txHash,
});

check("dispenser rows render identically from either shape", () => {
  const bad = [];
  for (const d of M.dispensers) {
    const r = artMap.get(d.asset);
    if (!r) continue;
    const a = strip(api.dispenserRow(d, r));
    const b = strip(api.dispenserRow(asLegacyDispenser(d), r));
    if (a !== b) bad.push(`${d.asset}\n    canonical: ${a}\n    legacy:    ${b}`);
  }
  return eq(bad.slice(0, 3), [], `${bad.length} dispensers rendering differently by shape`);
});

check("readDispenser produces the same normalised values from either shape", () => {
  const bad = [];
  for (const d of M.dispensers) {
    const a = api.readDispenser(d);
    const b = api.readDispenser(asLegacyDispenser(d));
    for (const k of ["priceSats", "giveUnits", "remainingUnits", "assetLongname"]) {
      if (a[k] !== b[k]) bad.push(`${d.asset}.${k}: canonical=${a[k]} legacy=${b[k]}`);
    }
  }
  return eq(bad.slice(0, 5), [], "normaliser disagrees across shapes");
});

/** Recast a canonical open order into the snake_case history shape. */
const asLegacyOrder = (o) => ({
  give_asset: o.giveAsset ?? o.asset,
  give_quantity: o.giveUnits,
  give_remaining: o.giveRemaining,
  get_asset: o.getAsset,
  get_quantity: o.getUnits,
  get_remaining: o.getRemaining,
  status: o.status,
  block_index: o.blockIndex,
  tx_hash: o.txHash,
});

check("open orders render identically from either shape", () => {
  const bad = [];
  for (const o of M.orders) {
    const r = api.orderArtwork(o, artMap);
    if (!r) continue;
    const a = strip(api.orderCard(o, r, false, artMap));
    const b = strip(api.orderCard(asLegacyOrder(o), r, false, artMap));
    if (a !== b) bad.push(`${o.asset}\n    canonical: ${a}\n    legacy:    ${b}`);
  }
  return eq(bad, [], "orders rendering differently by shape");
});

check("readOrder picks the same quantities from either shape", () => {
  const bad = [];
  for (const o of M.orders) {
    const a = api.readOrder(o), b = api.readOrder(asLegacyOrder(o));
    for (const k of ["giveShown", "getShown", "isOpen", "isFilled", "giveAsset", "getAsset"]) {
      if (a[k] !== b[k]) bad.push(`${o.asset}.${k}: canonical=${a[k]} legacy=${b[k]}`);
    }
  }
  return eq(bad, [], "order normaliser disagrees across shapes");
});

/* ------------------------------------------------------ a raw row is detectable */

check("a raw-integer dispenser is visibly wrong, proving the scale matters", () => {
  // Guards against someone "simplifying" the route back to passing raw values.
  const divisible = M.dispensers.find((d) => artMap.get(d.asset)?.divisible);
  ok(divisible, "expected at least one divisible dispenser in the snapshot");
  const raw = { ...asLegacyDispenser(divisible), give_remaining: divisible.remainingUnits * 1e8 };
  const correct = api.readDispenser(asLegacyDispenser(divisible)).remainingUnits;
  const wrong = api.readDispenser(raw).remainingUnits;
  return ok(wrong === correct * 1e8,
    `an unscaled raw value must differ by exactly 1e8, got ${wrong} vs ${correct}`);
});

summary("Schema parity");
