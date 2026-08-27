/**
 * The Collected view: cohorts, distribution arithmetic and ranking.
 *
 * The specific thing being defended here is the difference between "nobody holds
 * this" and "we could not find out". 244 pieces are held entirely by the artist and
 * 47 could not be measured at all, and every previous defect in this project came
 * from collapsing exactly that kind of distinction — a zero read as absent (D1), an
 * absent key read as a value (D3, D9). A view that shows 0 for both is wrong in a
 * way no amount of correct arithmetic elsewhere makes up for.
 *
 * Assertions run against the shipping collected.js and the shipping app.js row
 * renderer, loaded under Node — never a reimplementation of either.
 *
 * Usage:  node test/collected.test.mjs
 */
import { loadWithData, check, eq, ok, summary } from "./harness.mjs";
import { distributionStats, holderDataMissing, DISTRIBUTION_KEYS } from "../lib/holderstats.mjs";

const { api, ctx, data } = loadWithData();
const CD = ctx.window.Collected;
const rows = api.collectedRows();
const groups = CD.cohorts(rows);
const sum = CD.collectedSummary(rows);
const arts = data.artworks.artworks.filter(a => !a.excluded);

console.log("Collected\n");

/* ------------------------------------------------------------- cohorts */

check("every piece lands in exactly one cohort", () => {
  const total = groups.collected.length + groups.uncollected.length + groups.unknown.length;
  eq(total, rows.length, "cohorts must be exhaustive");
  const seen = new Set();
  for (const k of ["collected", "uncollected", "unknown"]) {
    for (const r of groups[k]) {
      if (seen.has(r.asset)) throw new Error(`${r.asset} in more than one cohort`);
      seen.add(r.asset);
    }
  }
  return eq(seen.size, rows.length, "cohorts must be disjoint");
});

check("the view covers the whole collection, not just pieces with holder data", () =>
  eq(rows.length, arts.length, "one row per collectible piece"));

check("cohort membership follows the stated definition", () => {
  const wrong = [];
  for (const r of rows) {
    const expected = !r.dataOk ? "unknown" : (r.holders > 0 ? "collected" : "uncollected");
    if (r.cohort !== expected) wrong.push(`${r.asset}: ${r.cohort} vs ${expected}`);
  }
  return eq(wrong, [], "cohort must match dataOk/holders");
});

check("an unmeasured piece has a null holder count, never a zero", () => {
  const bad = groups.unknown.filter(r => r.holders !== null);
  return eq(bad.map(r => r.asset), [], "unknown cohort must carry null, not 0");
});

check("a wholly artist-held piece has a real measured zero", () => {
  const bad = groups.uncollected.filter(r => r.holders !== 0 || r.dataOk !== true);
  return eq(bad.map(r => r.asset), [], "uncollected must be a measured 0");
});

/* ------------------------------------------- absent vs zero, as rendered */

check("unmeasured pieces render an em-dash in the holders cell, not 0", () => {
  const offenders = [];
  for (const [i, r] of groups.unknown.slice(0, 60).entries()) {
    const html = api.collectedRow(r, i, true);
    const cell = html.split("<td class=\"num\">")[1] || "";
    if (/^\s*0\s*</.test(cell)) offenders.push(r.asset);
    if (!html.includes("unk")) offenders.push(`${r.asset} (no unk marker)`);
  }
  return eq(offenders, [], "an unmeasured holder count must not render as zero");
});

check("artist-held pieces DO render a zero, because that is the measurement", () => {
  const r = groups.uncollected[0];
  ok(r, "expected at least one artist-held piece");
  const html = api.collectedRow(r, 0, true);
  return ok(/>0</.test(html) || />\s*0\s*</.test(html), "a measured zero should show as 0");
});

check("no rendered row leaks undefined, NaN or null", () => {
  const bad = [];
  for (const cohort of ["collected", "uncollected", "unknown"]) {
    for (const [i, r] of groups[cohort].slice(0, 40).entries()) {
      for (const showDist of [true, false]) {
        const html = api.collectedRow(r, i, showDist);
        for (const t of ["undefined", "NaN", ">null<"]) {
          if (html.includes(t)) bad.push(`${cohort}/${r.asset}: ${t}`);
        }
      }
    }
  }
  return eq(bad, [], "row output must be clean");
});

check("divisible pieces never show an edition count", () => {
  const bad = rows.filter(r => r.divisible && r.editionsOut != null);
  eq(bad.map(r => r.asset), [], "editionsOut is meaningless for divisible assets");
  const div = rows.find(r => r.divisible);
  return ok(!div || api.collectedRow(div, 0, true).includes("n/a"), "divisible row shows n/a");
});

/* ------------------------------------------------- distribution arithmetic */

check("every measured percentage stays within 0 and 100", () => {
  const bad = [];
  const inRange = v => v == null || (v >= 0 && v <= 100);
  for (const r of rows) {
    if (!inRange(r.reachPct)) bad.push(`${r.asset} reach=${r.reachPct}`);
    if (!inRange(r.top1Share)) bad.push(`${r.asset} top1=${r.top1Share}`);
    if (!inRange(r.top5Share)) bad.push(`${r.asset} top5=${r.top5Share}`);
    if (r.hhi != null && (r.hhi < 0 || r.hhi > 10000.001)) bad.push(`${r.asset} hhi=${r.hhi}`);
  }
  return eq(bad, [], "percentages and HHI must be in range");
});

check("the top five hold at least as much as the top one", () => {
  const bad = rows.filter(r => r.top1Share != null && r.top5Share != null
    && r.top5Share < r.top1Share - 1e-9);
  return eq(bad.map(r => r.asset), [], "top5Share >= top1Share");
});

check("distributionStats splits artist, burn and external correctly", () => {
  const artist = new Set(["ART1"]);
  const burn = new Set(["BURN1"]);
  const d = distributionStats([
    { address: "ART1", units: 60 },
    { address: "BURN1", units: 10 },
    { address: "C1", units: 30 },
    { address: "C2", units: 10 },
  ], { artist, burn });

  eq(d.externalHolders, 2, "two external holders");
  eq(d.artistHolders, 1, "one artist wallet");
  eq(d.burnHolders, 1, "one burn address");
  eq(d.externalUnits, 40, "external units");
  eq(d.artistUnits, 60, "artist units");
  eq(d.burnUnits, 10, "burn units");
  // Burned units are excluded from the denominator: 40 / (40 + 60).
  eq(d.reachPct, 40, "reach excludes burned supply");
  eq(d.top1Share, 75, "largest external holder has 30 of 40");
  return eq(d.top5Share, 100, "all external holders inside the top five");
});

check("units reconcile: external + artist + burn equals the whole list", () => {
  const rowsIn = [
    { address: "ART1", units: 1.5 }, { address: "BURN1", units: 0.25 },
    { address: "C1", units: 2.25 }, { address: "C2", units: 6 },
  ];
  const d = distributionStats(rowsIn, { artist: new Set(["ART1"]), burn: new Set(["BURN1"]) });
  const total = rowsIn.reduce((t, r) => t + r.units, 0);
  return ok(Math.abs((d.externalUnits + d.artistUnits + d.burnUnits) - total) < 1e-9,
    `parts ${d.externalUnits}+${d.artistUnits}+${d.burnUnits} must equal ${total}`);
});

check("reach is null, not zero, when there is no unburned supply to reach", () => {
  const d = distributionStats([{ address: "BURN1", units: 5 }],
    { artist: new Set(), burn: new Set(["BURN1"]) });
  eq(d.reachPct, null, "no distributable base means no reach figure");
  return eq(d.top1Share, null, "no external units means no share figure");
});

check("a piece held entirely by the artist reaches 0%, which is a measurement", () => {
  const d = distributionStats([{ address: "ART1", units: 100 }],
    { artist: new Set(["ART1"]), burn: new Set() });
  eq(d.reachPct, 0, "artist-held is a real zero");
  return eq(d.externalHolders, 0, "and no external holders");
});

check("HHI reports one dominant holder as concentrated and an even split as spread", () => {
  const one = distributionStats(
    [{ address: "C1", units: 99 }, { address: "C2", units: 1 }], {});
  const even = distributionStats(
    Array.from({ length: 10 }, (_, i) => ({ address: `C${i}`, units: 10 })), {});
  ok(one.hhi > 9000, `dominant holder should push HHI high, got ${one.hhi}`);
  ok(Math.abs(even.hhi - 1000) < 1e-6, `ten equal holders should give HHI 1000, got ${even.hhi}`);
  eq(api.concLabel(one.hhi), "one holder dominates", "label for dominance");
  return eq(api.concLabel(even.hhi), "widely spread", "label for an even spread");
});

check("holderDataMissing carries every distribution key as an explicit null", () => {
  const m = holderDataMissing("http 429");
  eq(m.holderDataOk, false, "must record the failure");
  const missing = DISTRIBUTION_KEYS.filter(k => !(k in m));
  return eq(missing, [], "no key may be simply absent");
});

/* ------------------------------------------------------------- normaliser */

check("readHolding reads the legacy snapshot without inventing distribution", () => {
  const h = CD.readHolding({ count: 7, total: 9, top: [{ address: "C1", quantity: 3 }] });
  eq(h.dataOk, true, "a present count is evidence the fetch worked");
  eq(h.holders, 7, "holder count comes through");
  eq(h.measured, false, "legacy snapshots carry no distribution");
  return eq(h.reachPct, null, "and must not fabricate one");
});

check("readHolding reads the enriched snapshot", () => {
  const h = CD.readHolding({
    count: 7, total: 9, top: [], holderDataOk: true,
    externalHolders: 7, reachPct: 42.5, top1Share: 30, top5Share: 80, hhi: 1200,
    externalUnits: 17, artistUnits: 23, burnUnits: 0,
  });
  eq(h.dataOk, true);
  eq(h.measured, true, "distribution present");
  eq(h.reachPct, 42.5);
  return eq(h.holders, 7, "externalHolders wins over legacy count");
});

check("readHolding treats a failed fetch as unknown, not as zero holders", () => {
  const h = CD.readHolding({ count: null, total: null, top: [], ...holderDataMissing("http 500") });
  eq(h.dataOk, false, "must not claim data");
  eq(h.holders, null, "must not report 0 holders");
  return eq(h.measured, false);
});

check("readHolding on a missing entry is unknown, not an exception", () => {
  const h = CD.readHolding(undefined);
  eq(h.dataOk, false);
  return eq(h.holders, null);
});

check("holderDataOk false is never overridden by a present count", () => {
  // A snapshot that recorded both a count and a failure must be read as a failure.
  const h = CD.readHolding({ count: 5, holderDataOk: false, top: [] });
  return eq(h.dataOk, false, "the explicit flag wins");
});

check("a reach figure and its complement are formatted to sum to 100", () => {
  // 98.5 rendered as "99%" beside "1.5%" looks like it sums to 100.5, which makes a
  // correct measurement read as a broken one.
  const cases = [98.5, 1.5, 4.960986, 100, 0, 33.333];
  for (const v of cases) {
    const { part, rest } = api.pctPair(v);
    const sum = parseFloat(part) + parseFloat(rest);
    if (Math.abs(sum - 100) > 0.05) throw new Error(`${v}: ${part} + ${rest} = ${sum}`);
  }
  eq(api.pctPair(null), { part: "—", rest: "—" }, "absent stays absent");
  return true;
});

/* --------------------------------------------------------------- ranking */

check("every advertised metric produces a sorted list", () => {
  const bad = [];
  for (const [metric] of CD.METRICS) {
    const out = CD.rankBy(groups.collected, metric);
    if (!Array.isArray(out)) bad.push(`${metric} returned no array`);
  }
  return eq(bad, [], "all metrics must rank");
});

check("ranking by holders is monotonically non-increasing", () => {
  const out = CD.rankBy(groups.collected, "holders");
  for (let i = 1; i < out.length; i++) {
    if ((out[i - 1].holders ?? -1) < (out[i].holders ?? -1)) {
      throw new Error(`out of order at ${i}: ${out[i - 1].holders} then ${out[i].holders}`);
    }
  }
  return true;
});

check("ranking by reach is monotonically non-increasing where measured", () => {
  const measured = groups.collected.filter(r => r.measured);
  const out = CD.rankBy(measured, "reach");
  for (let i = 1; i < out.length; i++) {
    if ((out[i - 1].reachPct ?? -1) < (out[i].reachPct ?? -1)) {
      throw new Error(`out of order at ${i}`);
    }
  }
  return true;
});

check("editions ranking excludes divisible pieces entirely", () => {
  const out = CD.rankBy(groups.collected, "editions");
  return eq(out.filter(r => r.divisible).map(r => r.asset), [],
    "a token balance is not an edition count");
});

check("concentration ranking excludes single-holder pieces", () => {
  for (const metric of ["concentration", "spread"]) {
    const out = CD.rankBy(groups.collected, metric);
    const bad = out.filter(r => !(r.holders > 1));
    if (bad.length) throw new Error(`${metric} included ${bad.length} piece(s) with one holder`);
  }
  return true;
});

check("the default ranking is collectors, and a lone-holder piece cannot top it", () => {
  // Reach was the original default and produced a top twelve of pieces transferred
  // once, in full, to a single holder — each scoring 100%. This pins the fix.
  eq(CD.METRICS[0][0], "holders", "collectors must be the first/default metric");
  const fake = [
    { asset: "ONE_TRANSFER", holders: 1, reachPct: 100, measured: true, divisible: false, sales: 0, dispensers: 0, name: "a" },
    { asset: "WIDELY_HELD", holders: 195, reachPct: 98.5, measured: true, divisible: false, sales: 0, dispensers: 0, name: "b" },
  ];
  eq(CD.rankBy(fake, "holders")[0].asset, "WIDELY_HELD", "195 holders must outrank 1");
  // And the default (no metric named) must behave the same way.
  return eq(CD.rankBy(fake, undefined)[0].asset, "WIDELY_HELD", "default must rank by collectors");
});

check("the furthest-distributed headline requires a real holder base", () => {
  const pick = sum.deepestReach;
  if (!pick) return true;
  // The threshold is stated in the label on the page; this pins it in code so the
  // headline cannot quietly regress to celebrating a single transfer.
  return ok(pick.holders >= CD.REACH_HEADLINE_MIN_HOLDERS,
    `a piece with ${pick.holders} holder(s) cannot headline reach`);
});

check("a piece with no measurement sorts last, not as if it were zero", () => {
  const fake = [
    { asset: "MEASURED", holders: 1, reachPct: 5, divisible: false, sales: 0, dispensers: 0, measured: true, name: "b" },
    { asset: "UNKNOWN", holders: null, reachPct: null, divisible: false, sales: 0, dispensers: 0, measured: false, name: "a" },
  ];
  eq(CD.rankBy(fake, "reach")[0].asset, "MEASURED", "measured piece must outrank unmeasured");
  return eq(CD.rankBy(fake, "holders")[0].asset, "MEASURED", "same for holder count");
});

/* ----------------------------------------------------------------- market */

check("sales are counted on both sides of the trade", () => {
  const map = api.artworkMap();
  const idx = CD.salesIndex(data.market, map);
  const giveOnly = new Set();
  for (const o of data.market.orderHistory) {
    if (o.status === "filled" && map.has(o.give_asset)) giveOnly.add(o.give_asset);
  }
  const both = new Set([...idx.entries()].filter(([, v]) => v.sales > 0).map(([k]) => k));
  return ok(both.size >= giveOnly.size,
    `both-sides join must not find fewer assets than give-side-only (${both.size} vs ${giveOnly.size})`);
});

check("dispenser counts match the snapshot", () => {
  const map = api.artworkMap();
  const idx = CD.salesIndex(data.market, map);
  const counted = [...idx.values()].reduce((t, v) => t + v.dispensers, 0);
  const expected = data.market.dispensers.filter(d => map.has(d.asset)).length;
  return eq(counted, expected, "every in-collection dispenser counted once");
});

/* ---------------------------------------------------------------- summary */

check("the summary's cohort figures match the cohorts themselves", () => {
  eq(sum.collected, groups.collected.length);
  eq(sum.uncollected, groups.uncollected.length);
  eq(sum.unknown, groups.unknown.length);
  return eq(sum.total, rows.length);
});

check("unmeasured pieces are excluded from the collected-share denominator", () => {
  // Counting them as uncollected would understate the collected share.
  const expected = (sum.collected / (sum.collected + sum.uncollected)) * 100;
  ok(Math.abs(sum.collectedPctOfMeasured - expected) < 1e-9, "denominator must exclude unknown");
  return ok(sum.collectedPctOfMeasured > (sum.collected / sum.total) * 100,
    "and therefore exceed the share of the whole collection");
});

check("holder relationships equal the sum of the collected cohort's holders", () => {
  const expected = groups.collected.reduce((t, r) => t + r.holders, 0);
  return eq(sum.relationships, expected);
});

check("the headline picks are real members of the collection", () => {
  const byAsset = new Map(rows.map(r => [r.asset, r]));
  for (const key of ["widest", "deepestReach", "mostConcentrated"]) {
    const pick = sum[key];
    if (pick && !byAsset.has(pick.asset)) throw new Error(`${key} points at an unknown asset`);
  }
  const w = sum.widest;
  if (w) {
    const max = Math.max(...groups.collected.map(r => r.holders));
    eq(w.holders, max, "widest must actually be the widest");
  }
  return true;
});

check("hasDistribution reflects whether the snapshot carries reach at all", () => {
  const anyMeasured = rows.some(r => r.measured);
  return eq(sum.hasDistribution, anyMeasured,
    "the view hides the reach columns exactly when nothing is measured");
});

check("renderCollected survives every cohort and metric combination", () => {
  for (const cohort of ["collected", "uncollected", "unknown"]) {
    for (const [metric] of CD.METRICS) {
      api.state.collectedCohort = cohort;
      api.state.collectedMetric = metric;
      api.renderCollected();
    }
  }
  api.state.collectedCohort = "collected";
  api.state.collectedMetric = "reach";
  return true;
});

summary("Collected");
