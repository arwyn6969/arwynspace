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

export default async function handler(req, res) {
  const addresses = (process.env.WALLETS || "1AwS3wRFNCoymKs69BXjAA4VfgWvuKvx4j")
    .split(",").map(s => s.trim()).filter(Boolean);

  const dispensers = [];

  // Preferred source: Counterparty itself.
  for (const addr of addresses) {
    const d = await jget(`${XCP}/v2/addresses/${addr}/dispensers?status=open&limit=500`);
    for (const row of d?.result ?? []) {
      if (Number(row.give_remaining) <= 0) continue;
      dispensers.push({
        asset: row.asset, source: row.source, satoshirate: Number(row.satoshirate),
        give_quantity: Number(row.give_quantity), give_remaining: Number(row.give_remaining),
        tx_hash: row.tx_hash, origin: "counterparty",
      });
    }
  }

  // Fallback: stampchain mirrors dispenser state and is reachable on 443.
  if (!dispensers.length) {
    for (const addr of addresses) {
      const d = await jget(`${STAMPCHAIN}/stamps/dispensers/${addr}?limit=500`);
      for (const row of d?.data ?? []) {
        if (row.close_block_index != null || Number(row.give_remaining) <= 0) continue;
        dispensers.push({
          asset: row.cpid, source: row.source, satoshirate: Number(row.satoshirate),
          give_quantity: Number(row.give_quantity), give_remaining: Number(row.give_remaining),
          tx_hash: row.tx_hash, origin: "stampchain",
        });
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
      if (o.give_asset !== asset) continue;
      orders.push({
        give_asset: o.give_asset, give_quantity: Number(o.give_quantity), give_remaining: Number(o.give_remaining),
        get_asset: o.get_asset, get_quantity: Number(o.get_quantity), get_remaining: Number(o.get_remaining),
        source: o.source, tx_hash: o.tx_hash,
      });
    }
  }

  const health = await jget(`${STAMPCHAIN}/health`);
  const btcPrice = Number(health?.metadata?.btcPrice) || null;

  res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=1800");
  res.status(200).json({ generatedAt: new Date().toISOString(), btcPrice, dispensers, orders });
}
