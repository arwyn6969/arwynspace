/* ============================================================
   Collector ranks, stats and views.

   Ranks are named after the mechanisms these artworks are actually built on —
   OP_RETURN through to unprunable stamp data — because a bronze/silver/gold
   ladder would say nothing about where the work lives.

   Ranking is by DISTINCT PIECES held, never by units. A single large-supply
   token would otherwise buy a top rank outright.
   ============================================================ */

const TIERS = [
  {
    min: 50, key: "unprunable", name: "Unprunable",
    blurb: "Holds so much of the collection it can't be pruned out of its story.",
  },
  {
    min: 25, key: "immutable", name: "Immutable",
    blurb: "Deep enough that the holding is a matter of record, not intent.",
  },
  {
    min: 10, key: "keyburn", name: "Keyburn",
    blurb: "Committed. No route back.",
  },
  {
    min: 5, key: "utxo", name: "UTXO Bound",
    blurb: "Tied to a real slice of the collection.",
  },
  {
    min: 2, key: "multisig", name: "Bare Multisig",
    blurb: "The encoding that made stamps possible — more than one piece held.",
  },
  {
    min: 1, key: "opreturn", name: "OP_RETURN",
    blurb: "A single push of data. Everyone starts here.",
  },
];

function tierFor(distinctPieces) {
  return TIERS.find(t => distinctPieces >= t.min) ?? TIERS[TIERS.length - 1];
}

function tierLadder() { return TIERS; }

/**
 * Derive per-collector stats that can be computed honestly from holder balances
 * and the artwork index. Deliberately excludes profit and loss: that needs each
 * acquisition price, and pieces obtained by transfer or gift have none.
 */
function collectorStats(entry, artworkByAsset, totalCollectible) {
  const held = (entry.assets || []).map(a => artworkByAsset.get(a)).filter(Boolean);

  const stamps = held.filter(r => r.isStamp);
  const xcp = held.filter(r => !r.isStamp);

  // Rarest piece by EFFECTIVE supply — how many separately ownable units exist.
  // The old version compared raw supply and skipped divisible assets, which made a
  // divisible token with supply 1 look rarer than a 21-edition card. Never-minted
  // assets are excluded because zero unlocked supply is not scarcity.
  const eff = r => (r.effectiveSupply != null
    ? r.effectiveSupply
    : Math.round((Number(r.supplyUnits ?? r.supply ?? 0) || 0) * (r.divisible ? 1e8 : 1)));
  const rankable = held.filter(r => {
    const u = Number(r.supplyUnits ?? r.supply ?? 0) || 0;
    return u > 0 || !!r.locked;
  });
  const rarest = rankable.length
    ? rankable.reduce((a, b) => (eff(a) <= eff(b) ? a : b))
    : null;

  // Earliest issuance among their holdings — a proxy for how far back they go.
  const dated = held.filter(r => r.firstBlock);
  const earliest = dated.length ? dated.reduce((a, b) => (a.firstBlock <= b.firstBlock ? a : b)) : null;

  const subassets = held.filter(r => r.assetLongname).length;
  const animated = held.filter(r => r.animated || r.media?.animationUrl).length;

  return {
    address: entry.address,
    pieces: entry.distinctAssets,
    editions: Math.round(entry.editions ?? 0),
    sharePct: totalCollectible ? (entry.distinctAssets / totalCollectible) * 100 : 0,
    stamps: stamps.length,
    xcp: xcp.length,
    subassets,
    animated,
    rarest,
    earliest,
    held,
    tier: tierFor(entry.distinctAssets),
  };
}

/** Collection-wide figures for the collectors page header. */
function collectorSummary(leaderboard, artworkByAsset, totalCollectible) {
  const counts = {};
  for (const t of TIERS) counts[t.key] = 0;
  let onlyStamps = 0, onlyXcp = 0, mixed = 0;

  for (const c of leaderboard) {
    counts[tierFor(c.distinctAssets).key]++;
    const held = (c.assets || []).map(a => artworkByAsset.get(a)).filter(Boolean);
    const s = held.filter(r => r.isStamp).length;
    const x = held.length - s;
    if (s && !x) onlyStamps++;
    else if (x && !s) onlyXcp++;
    else if (s && x) mixed++;
  }

  const top = leaderboard[0];
  return {
    collectors: leaderboard.length,
    tierCounts: counts,
    onlyStamps, onlyXcp, mixed,
    deepest: top ? { address: top.address, pieces: top.distinctAssets } : null,
    // How much of the collection the single largest holder has reached.
    deepestSharePct: top && totalCollectible ? (top.distinctAssets / totalCollectible) * 100 : 0,
  };
}

// Plain script, not a module: app.js is loaded the same way and the single-file
// bundle inlines both, so these are shared via the global scope.
window.Collectors = { TIERS, tierFor, tierLadder, collectorStats, collectorSummary };
