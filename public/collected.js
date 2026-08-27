/* ============================================================
   Which pieces are actually collected, and how widely.

   The Collectors view answers "who holds the most of this collection". This is the
   inverse question — "which of these pieces have found holders" — and it needs
   different arithmetic, because the honest answer is not a single ranked list.

   Measured over the current snapshot: of 489 indexed pieces, 198 have at least one
   external holder, 244 are held entirely by the artist, and 47 could not be
   measured at all because the upstream holder fetch failed. A single table sorted
   by holder count would therefore be 244 rows of "0" with 47 blanks scattered
   through it, implying a comparison that isn't there. So: three cohorts, each
   labelled for what it actually is.

   RANKING IS BY NUMBER OF COLLECTORS, with reach shown immediately beside it.

   Reach — the share of existing unburned supply in someone else's wallet — was
   tried as the default and is wrong for it: a piece transferred once, in full, to a
   single holder scores 100%, and twelve such pieces buried CARPOPODITE (195 holders,
   98.5% out) below them. One transfer is not being widely collected.

   Holder count alone is also incomplete, because it says nothing about how much of
   a piece actually moved: PUDSEC has 140 holders but only 5% of its supply out, so
   by headcount it looks like one of the most collected works here while the artist
   still holds 65.6 of its 69 million units. The fix is not a composite score that
   hides both problems behind one opaque number — it is to rank by collectors and
   put reach in the very next column, where it qualifies the headcount in view.
   Reach remains available as its own ranking, labelled for what it measures.
   ============================================================ */

/**
 * Read one `holders.byAsset` entry into a shape the view can render without
 * guessing. Handles both snapshot generations explicitly:
 *
 *   legacy    { count, total, top }                      — no distribution fields
 *   enriched  { ..., holderDataOk, reachPct, top1Share }  — measured over the full list
 *
 * This is the readOrder() pattern, and for the same reason: every defect in this
 * project has been a view reading a key its data didn't carry. `measured` says
 * whether the distribution numbers exist, so the view renders an em-dash rather
 * than a zero when they don't.
 */
function readHolding(entry) {
  if (!entry) return { dataOk: false, measured: false, holders: null, reachPct: null,
                       top1Share: null, top5Share: null, hhi: null,
                       externalUnits: null, artistUnits: null, burnUnits: null, reason: null };

  // holderDataOk is only absent on legacy snapshots, where a present count IS the
  // evidence the fetch succeeded. Never inferred from a zero.
  const dataOk = entry.holderDataOk === undefined
    ? entry.count != null
    : entry.holderDataOk === true;

  const holders = entry.externalHolders ?? entry.count ?? null;
  const measured = dataOk && entry.reachPct !== undefined && entry.reachPct !== null;

  return {
    dataOk,
    measured,
    holders: dataOk ? holders : null,
    reachPct: measured ? entry.reachPct : null,
    top1Share: measured ? entry.top1Share : null,
    top5Share: measured ? entry.top5Share : null,
    hhi: measured ? entry.hhi : null,
    externalUnits: dataOk ? (entry.externalUnits ?? null) : null,
    artistUnits: dataOk ? (entry.artistUnits ?? null) : null,
    burnUnits: dataOk ? (entry.burnUnits ?? null) : null,
    top: Array.isArray(entry.top) ? entry.top : [],
    reason: entry.reason ?? null,
  };
}

/**
 * Market activity per asset, from the same both-sides join the market view uses.
 * Counting only the give side dropped 18 of 154 events (D4) — a piece bought with
 * XCP sits on the get side — so this counts a sale as touching an asset either way.
 */
function salesIndex(market, artworkByAsset) {
  const out = new Map();
  const bump = (asset, key) => {
    if (!asset || !artworkByAsset.has(asset)) return;
    const cur = out.get(asset) || { sales: 0, dispensers: 0 };
    cur[key]++;
    out.set(asset, cur);
  };

  for (const o of market?.orderHistory || []) {
    if (o.status !== "filled") continue;
    // Both sides, and longnames, exactly as orderTouchesCollection does.
    for (const a of [o.give_asset, o.get_asset, o.giveAsset, o.getAsset,
                     o.give_asset_longname, o.get_asset_longname,
                     o.giveAssetLongname, o.getAssetLongname]) {
      if (a && artworkByAsset.has(a)) { bump(a, "sales"); break; }
    }
  }
  for (const d of market?.dispensers || []) bump(d.asset, "dispensers");
  return out;
}

/**
 * Per-asset stats row. `artwork` is the index entry; `entry` the byAsset block.
 */
function assetStats(artwork, entry, sales) {
  const h = readHolding(entry);
  const s = sales?.get(artwork.asset) || { sales: 0, dispensers: 0 };

  return {
    asset: artwork.asset,
    artwork,
    name: artwork.assetLongname || artwork.asset,
    title: artwork.title || artwork.asset,
    isStamp: !!artwork.isStamp,
    divisible: !!artwork.divisible,
    ...h,
    sales: s.sales,
    dispensers: s.dispensers,
    // Editions in external hands. Meaningful for indivisible pieces only: a
    // divisible balance is a token quantity, not a count of ownable editions, and
    // the two have never been comparable in this codebase.
    editionsOut: h.dataOk && !artwork.divisible ? h.externalUnits : null,
    cohort: !h.dataOk ? "unknown" : (h.holders > 0 ? "collected" : "uncollected"),
  };
}

/** Every piece, bucketed. Exhaustive and disjoint by construction. */
function cohorts(rows) {
  const out = { collected: [], uncollected: [], unknown: [] };
  for (const r of rows) out[r.cohort].push(r);
  return out;
}

const METRICS = [
  ["holders", "Most collectors"],
  ["reach", "Furthest distributed"],
  ["editions", "Most editions out"],
  ["concentration", "Most concentrated"],
  ["spread", "Most evenly held"],
  ["sales", "Most traded"],
  ["name", "Name"],
];

/**
 * Sort a cohort by the named metric. Rows missing the metric sort last rather than
 * as zero — an unmeasured piece is not a piece with a reach of nothing.
 */
function rankBy(rows, metric) {
  const arr = [...rows];
  const last = (v, dir) => (v == null ? (dir === "desc" ? -Infinity : Infinity) : v);

  switch (metric) {
    // Reach ranks pieces by how much of them left the artist, which is a real
    // question but NOT the same as "most collected" — see the note at the top.
    case "reach":
      return arr.sort((a, b) => last(b.reachPct, "desc") - last(a.reachPct, "desc")
        || last(b.holders, "desc") - last(a.holders, "desc"));
    case "editions":
      // Indivisible only: ranking a token balance against an edition count would be
      // the units-versus-editions conflation this project already fixed once.
      return arr.filter(r => !r.divisible)
        .sort((a, b) => last(b.editionsOut, "desc") - last(a.editionsOut, "desc"));
    case "concentration":
      return arr.filter(r => r.measured && r.holders > 1)
        .sort((a, b) => last(b.top1Share, "desc") - last(a.top1Share, "desc"));
    case "spread":
      return arr.filter(r => r.measured && r.holders > 1)
        .sort((a, b) => last(a.hhi, "asc") - last(b.hhi, "asc"));
    case "sales":
      return arr.sort((a, b) => b.sales - a.sales || b.dispensers - a.dispensers
        || last(b.holders, "desc") - last(a.holders, "desc"));
    case "name":
      return arr.sort((a, b) => a.name.localeCompare(b.name));
    default:
      return arr.sort((a, b) => last(b.holders, "desc") - last(a.holders, "desc")
        || last(b.reachPct, "desc") - last(a.reachPct, "desc"));
  }
}

/** Minimum holders for a piece to be eligible for the reach headline. */
const REACH_HEADLINE_MIN_HOLDERS = 10;

const median = xs => {
  const v = xs.filter(n => n != null).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

/** Collection-level figures for the page header. */
function collectedSummary(rows) {
  const c = cohorts(rows);
  const measured = c.collected.filter(r => r.measured);

  const pick = (list, fn) => (list.length ? list.reduce((a, b) => (fn(a) >= fn(b) ? a : b)) : null);
  const widest = pick(c.collected, r => r.holders ?? -1);
  // Restricted to pieces with a real holder base. A piece transferred once in full
  // scores 100% and would win this permanently while saying nothing at all; at two
  // holders it is barely better. The threshold is stated in the label rather than
  // applied silently, because a hidden filter on a headline figure is a lie of
  // omission — and the pick's own holder count is printed beside it either way.
  const deepestReach = pick(
    measured.filter(r => r.holders >= REACH_HEADLINE_MIN_HOLDERS),
    r => r.reachPct ?? -1);
  const mostConc = pick(measured.filter(r => r.holders > 1), r => r.top1Share ?? -1);

  return {
    total: rows.length,
    collected: c.collected.length,
    uncollected: c.uncollected.length,
    unknown: c.unknown.length,
    // Share of pieces that have found any holder, out of those actually measured.
    // Dividing by all 489 would quietly count 53 unmeasured pieces as uncollected.
    collectedPctOfMeasured: (c.collected.length + c.uncollected.length)
      ? (c.collected.length / (c.collected.length + c.uncollected.length)) * 100
      : null,
    relationships: c.collected.reduce((t, r) => t + (r.holders || 0), 0),
    medianReach: median(measured.map(r => r.reachPct)),
    medianHolders: median(c.collected.map(r => r.holders)),
    withSales: rows.filter(r => r.sales > 0).length,
    withDispensers: rows.filter(r => r.dispensers > 0).length,
    widest,
    deepestReach,
    mostConcentrated: mostConc,
    // True once the enriched snapshot has been indexed. Until then the view hides
    // the reach and concentration columns rather than showing a column of dashes.
    hasDistribution: measured.length > 0,
  };
}

window.Collected = {
  readHolding, salesIndex, assetStats, cohorts, rankBy, collectedSummary, METRICS, median,
  REACH_HEADLINE_MIN_HOLDERS,
};
