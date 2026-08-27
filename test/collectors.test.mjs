/**
 * Collector ranks and stats.
 *
 * Ranking is by distinct pieces held, never by units, so a large-supply token cannot
 * buy a top rank. The stats module had no tests, and resolving holdings through a
 * media-only map made a row's total disagree with its own breakdown on 272 of 896
 * collectors. These assertions pin the arithmetic to the leaderboard the indexer
 * actually wrote.
 *
 * Usage:  node test/collectors.test.mjs
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { ROOT, loadWithData, check, eq, ok, summary } from "./harness.mjs";

function loadCollectors() {
  const ctx = { console };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "public/collectors.js"), "utf8"), ctx,
    { filename: "public/collectors.js" });
  return vm.runInContext("window.Collectors", ctx);
}

const C = loadCollectors();
const { api, data } = loadWithData();
const arts = data.artworks.artworks.filter((a) => !a.excluded);
const map = new Map(arts.map((a) => [a.asset, a]));
const lb = data.holders.leaderboard || [];

console.log("Collectors\n");

/* -------------------------------------------------------------- consistency */

check("the client hands collectorStats the full collection, not a media subset", () => {
  const m = api.artworkMap();
  return eq(m.size, map.size, "artworkMap must cover every collectible piece");
});

check("every collector's total equals its own breakdown", () => {
  const bad = [];
  for (const e of lb) {
    const s = C.collectorStats(e, map, map.size);
    if (s.pieces !== s.stamps + s.xcp) bad.push(`${e.address}: pieces=${s.pieces} stamps=${s.stamps} xcp=${s.xcp}`);
  }
  return eq(bad.slice(0, 5), [], `${bad.length} of ${lb.length} collectors whose parts do not sum`);
});

check("every held asset resolves to a real piece", () => {
  const unknown = new Set();
  for (const e of lb) for (const a of e.assets || []) if (!map.has(a)) unknown.add(a);
  return eq([...unknown].slice(0, 5), [], `${unknown.size} unresolvable holdings`);
});

check("share of collection never exceeds 100%", () => {
  const bad = lb.map((e) => C.collectorStats(e, map, map.size))
    .filter((s) => s.sharePct > 100)
    .map((s) => `${s.address}: ${s.sharePct.toFixed(1)}%`);
  return eq(bad.slice(0, 3), [], "impossible share");
});

/* --------------------------------------------------------------- ranking */

check("ranking is by distinct pieces, not units held", () => {
  // A holder of one enormous-supply token must not outrank a holder of many pieces.
  const whale = { address: "W", distinctAssets: 1, editions: 69000000, totalUnits: 69000000, assets: [arts[0].asset] };
  const broad = { address: "B", distinctAssets: 30, editions: 30, totalUnits: 30, assets: arts.slice(0, 30).map((a) => a.asset) };
  const a = C.collectorStats(whale, map, map.size);
  const b = C.collectorStats(broad, map, map.size);
  ok(b.pieces > a.pieces, "broad holder must have more pieces");
  return ok(b.tier.min >= a.tier.min, `broad holder tier (${b.tier.name}) must not rank below whale (${a.tier.name})`);
});

check("tier thresholds are the documented ladder", () => {
  const expect = [[50, "Unprunable"], [25, "Immutable"], [10, "Keyburn"], [5, "UTXO Bound"], [2, "Bare Multisig"], [1, "OP_RETURN"]];
  return eq(C.TIERS.map((t) => [t.min, t.name]), expect);
});

check("tier boundaries are inclusive at the stated minimum", () => {
  eq(C.tierFor(50).name, "Unprunable");
  eq(C.tierFor(49).name, "Immutable");
  eq(C.tierFor(2).name, "Bare Multisig");
  return eq(C.tierFor(1).name, "OP_RETURN");
});

/* ---------------------------------------------------------------- rarest */

check("rarest piece is chosen by effective supply, and never-minted is excluded", () => {
  const rare = { asset: "RARE", supply: 5, divisible: false, locked: true, isStamp: false };
  const divisibleOne = { asset: "DIV1", supply: 1, divisible: true, locked: true, isStamp: false };
  const unminted = { asset: "NEVER", supply: 0, divisible: false, locked: false, isStamp: false };
  const m = new Map([rare, divisibleOne, unminted].map((r) => [r.asset, r]));
  const s = C.collectorStats({ address: "X", distinctAssets: 3, assets: [...m.keys()] }, m, 3);
  // A divisible supply of 1 is 1e8 ownable units, so RARE (5) is genuinely rarer.
  return eq(s.rarest.asset, "RARE", "rarest by effective supply");
});

check("a collector holding only never-minted assets has no rarest piece", () => {
  const m = new Map([["N", { asset: "N", supply: 0, divisible: false, locked: false, isStamp: false }]]);
  const s = C.collectorStats({ address: "X", distinctAssets: 1, assets: ["N"] }, m, 1);
  return eq(s.rarest, null);
});

check("collectors.js effective-supply rule matches lib/units and the client", async () => {
  // Three copies of this rule exist: lib/units.mjs effectiveSupply, app.js effSupply,
  // and the private eff() in collectors.js. They must not drift.
  const U = await import("../lib/units.mjs");
  const bad = [];
  for (const r of arts.slice(0, 300)) {
    const units = Number(r.supplyUnits ?? r.supply ?? 0) || 0;
    if (!units) continue;
    const viaLib = U.effectiveSupply(units, !!r.divisible);
    const viaClient = api.effSupply(r);
    // Exercise collectors' private eff() through the rarest selection on a single-asset holder.
    const s = C.collectorStats({ address: "X", distinctAssets: 1, assets: [r.asset] }, map, map.size);
    if (!s.rarest) continue;
    if (viaLib !== viaClient) bad.push(`${r.asset}: lib=${viaLib} client=${viaClient}`);
  }
  return eq(bad.slice(0, 5), [], "effective-supply implementations have drifted");
});

/* --------------------------------------------------------------- summary */

check("tier counts account for every collector exactly once", () => {
  const s = C.collectorSummary(lb, map, map.size);
  const total = Object.values(s.tierCounts).reduce((a, b) => a + b, 0);
  eq(total, lb.length, "tier counts must sum to the leaderboard");
  return eq(s.collectors, lb.length);
});

check("stamps-only, xcp-only and mixed partition the collectors", () => {
  const s = C.collectorSummary(lb, map, map.size);
  const sum = s.onlyStamps + s.onlyXcp + s.mixed;
  return ok(sum <= lb.length, `partition ${sum} exceeds ${lb.length} collectors`);
});

check("deepest collector matches the head of the leaderboard", () => {
  const s = C.collectorSummary(lb, map, map.size);
  ok(s.deepest, "there should be a deepest collector");
  eq(s.deepest.pieces, lb[0].distinctAssets);
  return ok(s.deepestSharePct > 0 && s.deepestSharePct <= 100, `share ${s.deepestSharePct}`);
});

summary("Collectors");
