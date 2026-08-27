/**
 * Live market data: open dispensers and DEX orders for the collection.
 *
 * This runs server-side on purpose. The Counterparty node listens on port 4000,
 * which browsers and corporate firewalls frequently block, and calling it from
 * the page would also expose visitors to its rate limits. Proxying here means
 * one warm cache serves everyone.
 */

const XCP = process.env.XCP_API || "https://api.counterparty.io:4000";
const STAMPCHAIN = "https://stampchain.io/api/v2";

async function jget(url, timeout = 9000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeout);
  try {
    const r = await fetch(url, { signal: c.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; } finally { clearTimeout(t); }
}

const SATS = 1e8;

/**
 * Normalise a dispenser row into the ONE canonical shape the rest of the site uses.
 *
 * This route previously emitted `satoshirate` / `give_quantity` / `give_remaining`
 * straight from upstream. Both upstreams here report RAW integers — the chain's
 * smallest-unit counts — while the client reads those field names as HUMAN units and
 * does not rescale. Every divisible dispenser served by this route would therefore
 * have rendered 100,000,000x too large: PUDSEC's 0.00000987 remaining as 987.
 *
 * It never happened only because this route has never been deployed. Emitting the
 * indexer's camelCase shape means there is a single schema to reason about, and the
 * client's tolerance for the older one is a safety net rather than load-bearing.
 * test/schema.test.mjs asserts both shapes still render identically.
 */
function normaliseDispenser(row, { assetKey, origin }) {
  const divisible = !!row.asset_info?.divisible;
  const scale = divisible ? SATS : 1;
  const giveUnits = (Number(row.give_quantity) || 0) / scale;
  const remainingUnits = (Number(row.give_remaining) || 0) / scale;
  const priceSats = Number(row.satoshirate) || 0;
  if (giveUnits <= 0 || remainingUnits <= 0) return null;
  return {
    asset: row[assetKey],
    assetLongname: row.asset_info?.asset_longname || null,
    source: row.source,
    priceSats,
    priceBtc: Number(row.btcrate) || priceSats / SATS,
    giveUnits,
    remainingUnits,
    divisible,
    txHash: row.tx_hash,
    origin,
  };
}

/**
 * Normalise a DEX order into the canonical camelCase shape, in human units.
 *
 * Counterparty v2 reports raw integers on both sides, and the two sides can have
 * different divisibility — an indivisible card priced in divisible XCP is the common
 * case. Each side is therefore scaled by its own asset's divisibility, taken from the
 * row's asset_info where the node supplies it.
 */
function normaliseOrder(o) {
  const scaleOf = info => (info?.divisible ? SATS : 1);
  const gs = scaleOf(o.give_asset_info);
  const rs = scaleOf(o.get_asset_info);
  const num = (v, s) => (Number(v) || 0) / s;
  return {
    giveAsset: o.give_asset,
    giveAssetLongname: o.give_asset_info?.asset_longname || null,
    giveUnits: num(o.give_quantity, gs),
    giveRemaining: num(o.give_remaining, gs),
    getAsset: o.get_asset,
    getAssetLongname: o.get_asset_info?.asset_longname || null,
    getUnits: num(o.get_quantity, rs),
    getRemaining: num(o.get_remaining, rs),
    status: o.status || "open",
    source: o.source,
    txHash: o.tx_hash,
    blockIndex: o.block_index ?? null,
  };
}

export default async function handler(req, res) {
  const addresses = (process.env.WALLETS || "1AwS3wRFNCoymKs69BXjAA4VfgWvuKvx4j")
    .split(",").map(s => s.trim()).filter(Boolean);


  const dispensers = [];

  // Preferred source: Counterparty itself.
  for (const addr of addresses) {
    const d = await jget(`${XCP}/v2/addresses/${addr}/dispensers?status=open&limit=500`);
    for (const row of d?.result ?? []) {
      const n = normaliseDispenser(row, { assetKey: "asset", origin: "counterparty" });
      if (n) dispensers.push(n);
    }
  }

  // Fallback: stampchain mirrors dispenser state and is reachable on 443.
  if (!dispensers.length) {
    for (const addr of addresses) {
      const d = await jget(`${STAMPCHAIN}/stamps/dispensers/${addr}?limit=500`);
      for (const row of d?.data ?? []) {
        if (row.close_block_index != null) continue;
        const n = normaliseDispenser(row, { assetKey: "cpid", origin: "stampchain" });
        if (n) dispensers.push(n);
      }
    }
  }

  // Orders only for assets that actually have a dispenser or were requested,
  // so this stays inside the function's time budget.
  const orders = [];
  const wanted = (req.query?.assets || "").split(",").map(s => s.trim()).filter(Boolean);
  const assetList = wanted.length ? wanted : [...new Set(dispensers.map(d => d.asset))];
  for (const asset of assetList.slice(0, 40)) {
    const d = await jget(`${XCP}/v2/assets/${encodeURIComponent(asset)}/orders?status=open&limit=25`);
    for (const o of d?.result ?? []) {
      // Both sides matter. Filtering on give_asset alone drops every order where the
      // collection asset is being BOUGHT rather than offered — the same one-sided
      // join that hid real trades in the client.
      if (o.give_asset !== asset && o.get_asset !== asset) continue;
      orders.push(normaliseOrder(o));
    }
  }

  const health = await jget(`${STAMPCHAIN}/health`);
  const btcPrice = Number(health?.metadata?.btcPrice) || null;

  res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=1800");
  res.status(200).json({
    generatedAt: new Date().toISOString(),
    units: "human",
    btcPrice,
    // Same provenance fields the indexer writes, so the freshness badge reads the
    // same keys whichever path served the data.
    dispensersSource: dispensers.length ? dispensers[0].origin : null,
    dispensersFetchedAt: new Date().toISOString(),
    dispensers,
    orders,
  });
}
